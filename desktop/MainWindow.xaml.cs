using System;
using System.IO;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace MyAgent.Desktop;

public partial class MainWindow : Window
{
    private static readonly HttpClient Http = new() { Timeout = Timeout.InfiniteTimeSpan };
    private static readonly Brush Fg = new SolidColorBrush(Color.FromRgb(0xE8, 0xE6, 0xE3));
    private static readonly Brush Muted = new SolidColorBrush(Color.FromRgb(0x9A, 0x9A, 0x9A));
    private static readonly Brush Accent = new SolidColorBrush(Color.FromRgb(0xD9, 0x77, 0x57));
    private static readonly Brush Ok = new SolidColorBrush(Color.FromRgb(0x7F, 0xC7, 0x7F));
    private static readonly Brush Err = new SolidColorBrush(Color.FromRgb(0xE0, 0x6C, 0x6C));
    private static readonly Brush Panel = new SolidColorBrush(Color.FromRgb(0x23, 0x23, 0x29));
    private static readonly Brush Input = new SolidColorBrush(Color.FromRgb(0x2B, 0x2B, 0x31));
    private static readonly Brush Border = new SolidColorBrush(Color.FromRgb(0x3A, 0x3A, 0x42));

    private string? _sessionId;
    private CancellationTokenSource? _cts;
    private TextBlock? _currentAssistant;
    private Border? _currentThinking;
    private TextBlock? _currentThinkingBody;
    private TextBlock? _lastToolResult;
    private string? _approvalId;
    private bool _webSearchTriggered = false;
    private string _lastUserQuestion = "";

    public MainWindow()
    {
        InitializeComponent();
        
        // Initialize
        Loaded += async (_, _) =>
        {
            await RefreshModelsAsync();

            try
            {
                var resp = await Http.GetAsync(ServerUrl + "/project");
                if (resp.IsSuccessStatusCode)
                {
                    var json = await resp.Content.ReadAsStringAsync();
                    if (TryStr(json, "root", out var root)) ProjectBox.Text = root;
                }
            }
            catch { }
        };
    }

    private string ServerUrl => ServerBox.Text.Trim();

    private async Task RefreshModelsAsync()
    {
        try
        {
            var resp = await Http.GetAsync(ServerUrl + "/models");
            if (resp.IsSuccessStatusCode)
            {
                var json = await resp.Content.ReadAsStringAsync();
                var models = Array.Empty<string>();
                try
                {
                    using var doc = JsonDocument.Parse(json);
                    if (doc.RootElement.TryGetProperty("models", out var modelsEl) && modelsEl.ValueKind == JsonValueKind.Array)
                    {
                        models = JsonSerializer.Deserialize<string[]>(modelsEl.GetRawText()) ?? Array.Empty<string>();
                    }
                    else if (TryStr(json, "models", out var modelsJson))
                    {
                        models = JsonSerializer.Deserialize<string[]>(modelsJson) ?? Array.Empty<string>();
                    }
                }
                catch { }
                
                ModelCombo.ItemsSource = models;
                if (models.Length > 0) ModelCombo.SelectedItem = models[0];
            }
            else
            {
                System.Diagnostics.Debug.WriteLine($"Failed to load models, status code: {resp.StatusCode}");
                AddStatus($"⚠ Failed to load models (status: {resp.StatusCode}). Check if agent server is running on {ServerUrl}");
            }
        }
        catch (Exception ex)
        {
            System.Diagnostics.Debug.WriteLine($"Exception loading models: {ex.Message}");
            AddStatus($"⚠ Error loading models: {ex.Message}. Check if agent server is running on {ServerUrl}");
        }
    }

    private async Task CheckHealthAsync()
    {
        try
        {
            var resp = await Http.GetAsync(ServerUrl + "/health");
            if (resp.IsSuccessStatusCode)
            {
                var json = await resp.Content.ReadAsStringAsync();
                ConnLabel.Text = "● connected";
                ConnLabel.Foreground = Ok;
                if (TryStr(json, "project", out var project)) ProjectBox.Text = project;
            }
            else
            {
                ConnLabel.Text = "● disconnected";
                ConnLabel.Foreground = Err;
                System.Diagnostics.Debug.WriteLine($"Health check failed with status: {resp.StatusCode}");
                AddStatus($"⚠ Health check failed (status: {resp.StatusCode}). Check if agent server is running on {ServerUrl}");
            }
        }
        catch (Exception ex)
        {
            ConnLabel.Text = "● error";
            ConnLabel.Foreground = Err;
            System.Diagnostics.Debug.WriteLine($"Health check exception: {ex.Message}");
            AddStatus($"⚠ Health check failed: {ex.Message}. Check if agent server is running on {ServerUrl}");
        }
    }

    private async void RefreshModels_Click(object sender, RoutedEventArgs e) => await RefreshModelsAsync();
    private async void SetProject_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            var root = ProjectBox.Text.Trim();
            if (root.Length == 0) return;
            var payload = JsonSerializer.Serialize(new { root });
            var resp = await Http.PostAsync(ServerUrl + "/project",
                new StringContent(payload, Encoding.UTF8, "application/json"));
            resp.EnsureSuccessStatusCode();
            await CheckHealthAsync();
        }
        catch { }
    }

    private async void Send_Click(object sender, RoutedEventArgs e) => await SendAsync();
    
    private async void InputBox_KeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Enter && (Keyboard.Modifiers & ModifierKeys.Control) == 0)
        {
            await SendAsync();
        }
    }

    private async Task SendAsync()
    {
        var text = InputBox.Text.Trim();
        if (text.Length == 0 || _cts != null) return;
        InputBox.Text = "";
        AddUser(text);
        _lastUserQuestion = text;
        _webSearchTriggered = false;
        SendBtn.IsEnabled = false;
        StopBtn.Visibility = Visibility.Visible;
        _cts = new CancellationTokenSource();

        var payload = JsonSerializer.Serialize(new
        {
            sessionId = _sessionId,
            message = text,
            model = ModelCombo.SelectedItem as string,
            autoApprove = false,
        });

        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Post, ServerUrl + "/chat")
            {
                Content = new StringContent(payload, Encoding.UTF8, "application/json"),
            };
            using var resp = await Http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, _cts.Token);
            resp.EnsureSuccessStatusCode();
            await using var stream = await resp.Content.ReadAsStreamAsync(_cts.Token);
            using var reader = new StreamReader(stream);

            string? eventName = null;
            string? line;
            while ((line = await reader.ReadLineAsync()) != null)
            {
                _cts.Token.ThrowIfCancellationRequested();
                if (line.StartsWith("event:")) eventName = line.Substring(6).Trim();
                else if (line.StartsWith("data:"))
                {
                    var data = line.Substring(5).TrimStart();
                    HandleEvent(eventName, data);
                }
            }
        }
        catch (OperationCanceledException)
        {
            AddStatus("⏹ Stopped.");
        }
        catch (Exception ex)
        {
            AddStatus("✖ " + ex.Message);
        }
        finally
        {
            _cts?.Dispose();
            _cts = null;
            SendBtn.IsEnabled = true;
            StopBtn.Visibility = Visibility.Collapsed;
        }
    }

    private void Stop_Click(object sender, RoutedEventArgs e)
    {
        _cts?.Cancel();
    }

    private void CloseBtn_Click(object sender, RoutedEventArgs e)
    {
        this.Close();
    }

    // Copy to clipboard helper
    private void CopyToClipboard(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return;
        try
        {
            Clipboard.SetText(text);
            AddStatus("✓ Copied to clipboard");
        }
        catch (Exception)
        {
            AddStatus("✖ Failed to copy to clipboard");
        }
    }

    private void HandleEvent(string? eventName, string data)
    {
        switch (eventName)
        {
            case "start":
                if (TryStr(data, "sessionId", out var sid)) _sessionId = sid;
                break;
            case "status":
                if (TryStr(data, "message", out var m)) AddStatus(m);
                break;
            case "assistant":
                if (TryStr(data, "content", out var c)) 
                {
                    AppendAssistant(c);
                    if (string.IsNullOrWhiteSpace(c) && !_webSearchTriggered)
                    {
                        _webSearchTriggered = true;
                        AddStatus("ℹ️ No content from model, triggering web search...");
                        Dispatcher.Invoke(() => PerformWebSearch(_lastUserQuestion));
                    }
                }
                break;
            case "thinking":
                if (TryStr(data, "content", out var t)) AppendThinking(t);
                break;
            case "tool":
                if (TryStr(data, "name", out var n)) AddTool(n, Raw(data, "arguments"));
                break;
            case "tool_result":
                HandleToolResult(data);
                break;
            case "approve_request":
                if (TryStr(data, "id", out var id) && TryStr(data, "name", out var name))
                    ShowApproval(id, name, Raw(data, "arguments"));
                break;
            case "stopped":
                AddStatus("⏹ Stopped.");
                break;
            case "error":
                if (TryStr(data, "message", out var em)) AddStatus("✖ " + em);
                break;
        }
        ChatScroller.ScrollToEnd();
    }

    private void HandleToolResult(string data)
    {
        var ok = GetBool(data, "ok");
        var summary = GetStr(data, "summary") ?? GetStr(data, "error") ?? "done";
        if (_lastToolResult == null) return;
        _lastToolResult.Text = (ok ? "✓ " : "✗ ") + summary;
        _lastToolResult.Foreground = ok ? Ok : Err;
    }

    // -------------------------------------------------------------- approval

    private void ShowApproval(string id, string name, string args)
    {
        _approvalId = id;
        ApprovalName.Text = name;
        ApprovalArgs.Text = args;
        ApprovalBar.Visibility = Visibility.Visible;
    }

    private async void Approve_Click(object sender, RoutedEventArgs e) => await RespondApproval(true, "once");
    private async void Session_Click(object sender, RoutedEventArgs e) => await RespondApproval(true, "session");
    private async void Always_Click(object sender, RoutedEventArgs e) => await RespondApproval(true, "always");
    private async void Deny_Click(object sender, RoutedEventArgs e) => await RespondApproval(false, "once");

    private async Task RespondApproval(bool allowed, string scope)
    {
        var id = _approvalId;
        if (id == null) return;
        _approvalId = null;
        ApprovalBar.Visibility = Visibility.Collapsed;
        try
        {
            await Http.PostAsync(ServerUrl + "/approve",
                new StringContent(JsonSerializer.Serialize(new { id, allowed, scope }), Encoding.UTF8, "application/json"));
        }
        catch { }
    }

    // -------------------------------------------------------------- rendering

    private void AddUser(string text)
    {
        var border = new Border
        {
            Background = Input,
            BorderBrush = Border,
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(8),
            Padding = new Thickness(10),
            Margin = new Thickness(40, 4, 0, 0),
            HorizontalAlignment = HorizontalAlignment.Right,
            MaxWidth = 720,
        };
        border.Child = new TextBlock { Text = text, TextWrapping = TextWrapping.Wrap, Foreground = Fg };
        ChatPanel.Children.Add(border);
        ResetBlocks();
    }

    private void AppendAssistant(string text)
    {
        if (_currentAssistant == null)
        {
            _currentAssistant = new TextBlock
            {
                TextWrapping = TextWrapping.Wrap,
                Foreground = Fg,
                Margin = new Thickness(0, 4, 0, 0),
                MaxWidth = 900,
            };
            ChatPanel.Children.Add(_currentAssistant);
            _currentThinking = null;
        }
        _currentAssistant.Text += text;
    }

    private void AppendThinking(string text)
    {
        if (_currentThinking == null)
        {
            var border = new Border
            {
                Background = Panel,
                BorderBrush = Border,
                BorderThickness = new Thickness(1),
                CornerRadius = new CornerRadius(6),
                Padding = new Thickness(8),
                Margin = new Thickness(0, 4, 0, 0),
            };
            var stack = new StackPanel();
            stack.Children.Add(new TextBlock { Text = "💭 Thinking", Foreground = Muted, FontSize = 11 });
            _currentThinkingBody = new TextBlock
            {
                TextWrapping = TextWrapping.Wrap,
                Foreground = Muted,
                FontStyle = FontStyles.Italic,
                FontSize = 12,
                MaxHeight = 160,
            };
            stack.Children.Add(_currentThinkingBody);
            border.Child = stack;
            ChatPanel.Children.Add(border);
            _currentThinking = border;
            _currentAssistant = null;
        }
        _currentThinkingBody!.Text += text;
    }

    private void AddTool(string name, string argsJson)
    {
        ResetBlocks();
        var border = new Border
        {
            Background = Panel,
            BorderBrush = Border,
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(6),
            Padding = new Thickness(8),
            Margin = new Thickness(0, 4, 0, 0),
        };
        var stack = new StackPanel();
        stack.Children.Add(new TextBlock { Text = "⚙ " + name, Foreground = Accent, FontWeight = FontWeights.Bold, FontSize = 12 });
        if (!string.IsNullOrWhiteSpace(argsJson))
            stack.Children.Add(new TextBlock { Text = argsJson, Foreground = Muted, FontSize = 11, TextWrapping = TextWrapping.Wrap });
        _lastToolResult = new TextBlock { Text = "…", Foreground = Muted, FontSize = 11, Margin = new Thickness(0, 4, 0, 0) };
        stack.Children.Add(_lastToolResult);
        border.Child = stack;
        ChatPanel.Children.Add(border);
    }

    private void AddStatus(string text)
    {
        ResetBlocks();
        ChatPanel.Children.Add(new TextBlock
        {
            Text = text,
            Foreground = Muted,
            FontStyle = FontStyles.Italic,
            Margin = new Thickness(0, 4, 0, 0),
            TextWrapping = TextWrapping.Wrap,
        });
    }

    private void ResetBlocks()
    {
        _currentAssistant = null;
        _currentThinking = null;
        _lastToolResult = null;
    }

    // ------------------------------------------------------------------ json

    private static bool TryStr(string data, string key, out string value)
    {
        value = string.Empty;
        try
        {
            using var doc = JsonDocument.Parse(data);
            if (doc.RootElement.TryGetProperty(key, out var el) && el.ValueKind == JsonValueKind.String)
            {
                value = el.GetString() ?? string.Empty;
                return true;
            }
        }
        catch { }
        return false;
    }

    private static string? GetStr(string data, string key)
    {
        try
        {
            using var doc = JsonDocument.Parse(data);
            if (doc.RootElement.TryGetProperty(key, out var el) && el.ValueKind == JsonValueKind.String)
                return el.GetString();
        }
        catch { }
        return null;
    }

    private static bool GetBool(string data, string key)
    {
        try
        {
            using var doc = JsonDocument.Parse(data);
            if (doc.RootElement.TryGetProperty(key, out var el) && el.ValueKind == JsonValueKind.True)
                return true;
        }
        catch { }
        return false;
    }

    private static string Raw(string data, string key)
    {
        try
        {
            using var doc = JsonDocument.Parse(data);
            if (doc.RootElement.TryGetProperty(key, out var el))
                return el.GetRawText();
        }
        catch { }
        return string.Empty;
    }
    
    // Web search integration
    private const string BingSearchEndpoint = "https://api.bing.microsoft.com/v7.0/search";
    private const string BingSearchSubscriptionKey = "YOUR_BING_SEARCH_API_KEY_HERE"; // Set your Bing Search API key here

    private async void PerformWebSearch(string query)
    {
        try
        {
            AppendAssistant($"\n\n[Web search results for: \"{query}\"]\n\n");

            var request = new HttpRequestMessage(HttpMethod.Get, $"{BingSearchEndpoint}?q={Uri.EscapeDataString(query)}&count=10&offset=0&freshness=Day&textFormat=Raw&responseFormat=Json");
            
            if (!string.IsNullOrEmpty(BingSearchSubscriptionKey))
            {
                request.Headers.Add("Ocp-Apim-Subscription-Key", BingSearchSubscriptionKey);
            }

            using var resp = await Http.SendAsync(request);
            if (!resp.IsSuccessStatusCode)
            {
                AddStatus($"⚠ Web search failed (status: {resp.StatusCode})");
                AppendAssistant("\n❌ Web search failed. No results available.\n");
                return;
            }

            var json = await resp.Content.ReadAsStringAsync();
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;

            if (!root.TryGetProperty("webPages", out var webPages))
            {
                AppendAssistant("\n❌ No web pages found in search results.\n");
                return;
            }

            if (webPages.ValueKind == JsonValueKind.Null || !webPages.TryGetProperty("value", out var results))
            {
                AppendAssistant("\n❌ No search results available.\n");
                return;
            }

            var resultItems = results.Deserialize<JsonElement[]>();
            var hasImages = false;

            foreach (var result in resultItems)
            {
                var title = GetStrResult(result, "name");
                var snippet = GetStrResult(result, "snippet");
                var url = GetStrResult(result, "url");

                if (string.IsNullOrEmpty(title) && string.IsNullOrEmpty(snippet)) continue;

                // Check if this result has images
                var imageUrl = ExtractFirstImageUrl(snippet);
                if (!string.IsNullOrEmpty(imageUrl)) hasImages = true;

                // Display result with appropriate formatting
                var resultText = $"\n▶ {title}\n{snippet}\n🔗 {url}\n";
                AppendAssistant(resultText);

                // If image is available, display it
                if (!string.IsNullOrEmpty(imageUrl))
                {
                    ShowImageInChat(imageUrl, $"Related image for: {title}");
                }
            }

            if (!hasImages)
            {
                AppendAssistant("\nℹ️ No images found in search results.\n");
            }
        }
        catch (Exception ex)
        {
            AddStatus($"⚠ Web search error: {ex.Message}");
            AppendAssistant($"\n❌ Web search error: {ex.Message}\n");
        }
    }

    private static string GetStrResult(JsonElement result, string key)
    {
        try
        {
            if (result.TryGetProperty(key, out var prop) && prop.ValueKind == JsonValueKind.String)
                return prop.GetString() ?? string.Empty;
        }
        catch { }
        return string.Empty;
    }

    private static string ExtractFirstImageUrl(string text)
    {
        try
        {
            // Look for common image URL patterns in text
            var imgMatch = System.Text.RegularExpressions.Regex.Match(text, @"(https?://[^\s]+(?:png|jpe?g|gif|webp)(?:\?[^\s]*)?)", 
                System.Text.RegularExpressions.RegexOptions.IgnoreCase);
            if (imgMatch.Success)
                return imgMatch.Value;
        }
        catch { }
        return string.Empty;
    }

    // Method for displaying images in chat with proper binding
    private void ShowImageInChat(string imageUrl, string caption = "")
    {
        try
        {
            var border = new Border
            {
                Background = Panel,
                BorderBrush = Border,
                BorderThickness = new Thickness(1),
                CornerRadius = new CornerRadius(6),
                Padding = new Thickness(8),
                Margin = new Thickness(0, 4, 0, 0),
            };

            var stack = new StackPanel();

            // Load actual image from URL
            var image = new System.Windows.Controls.Image
            {
                Source = new System.Windows.Media.Imaging.BitmapImage(new Uri(imageUrl)),
                Stretch = System.Windows.Media.Stretch.Uniform,
                MaxWidth = 720,
                MaxHeight = 400,
                Margin = new Thickness(0, 0, 0, 8)
            };

            stack.Children.Add(image);

            if (!string.IsNullOrEmpty(caption))
            {
                var captionBlock = new TextBlock
                {
                    Text = caption,
                    Foreground = Muted,
                    FontSize = 12,
                    TextWrapping = TextWrapping.Wrap,
                    Margin = new Thickness(0, 0, 0, 4)
                };
                stack.Children.Add(captionBlock);
            }

            border.Child = stack;
            ChatPanel.Children.Add(border);

            ChatScroller.ScrollToBottom();
        }
        catch (Exception ex)
        {
            AddStatus($"⚠ Failed to display image: {ex.Message}");
            // Fallback: show placeholder
            var border = new Border
            {
                Background = Panel,
                BorderBrush = Border,
                BorderThickness = new Thickness(1),
                CornerRadius = new CornerRadius(6),
                Padding = new Thickness(8),
                Margin = new Thickness(0, 4, 0, 0),
            };
            var text = new TextBlock
            {
                Text = $"🖼 Image unavailable: {imageUrl}",
                Foreground = Muted,
                FontStyle = FontStyles.Italic,
                TextWrapping = TextWrapping.Wrap,
                Margin = new Thickness(0, 4, 0, 0)
            };
            border.Child = text;
            ChatPanel.Children.Add(border);
        }
    }
    

}