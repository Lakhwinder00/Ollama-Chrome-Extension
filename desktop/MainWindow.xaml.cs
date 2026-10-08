using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
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
    private readonly StringBuilder _turnAnswer = new();
    private bool _serverSearchedWeb = false;
    private bool _stoppedByUser = false;
    private readonly HashSet<string> _shownImages = new(StringComparer.OrdinalIgnoreCase);
    private const int MaxImagesPerTurn = 3;

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
        _serverSearchedWeb = false;
        _stoppedByUser = false;
        _turnAnswer.Clear();
        _shownImages.Clear();
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

            // The stream is over: if the local model produced nothing usable,
            // fall back to the internet so the user still gets an answer.
            await RunWebFallbackIfNoAnswerAsync(_cts.Token);
            // Any turn that touched the web gets a few matching images too.
            await ShowRelatedImagesAsync(_cts.Token);
        }
        catch (OperationCanceledException)
        {
            AddStatus("⏹ Stopped.");
        }
        catch (Exception ex)
        {
            AddStatus("✖ " + ex.Message);
            await RunWebFallbackIfServerUnreachableAsync(ex);
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
                if (TryStr(data, "content", out var c) && !string.IsNullOrEmpty(c))
                {
                    EmitAnswer(c);
                }
                break;
            case "thinking":
                if (TryStr(data, "content", out var t)) AppendThinking(t);
                break;
            case "tool":
                if (TryStr(data, "name", out var n))
                {
                    if (n == "web_search" || n == "fetch_url") _serverSearchedWeb = true;
                    AddTool(n, Raw(data, "arguments"));
                }
                break;
            case "tool_result":
                HandleToolResult(data);
                break;
            case "approve_request":
                if (TryStr(data, "id", out var id) && TryStr(data, "name", out var name))
                    ShowApproval(id, name, Raw(data, "arguments"));
                break;
            case "stopped":
                _stoppedByUser = true;
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

    /// <summary>
    /// Appends answer text and picks up any image URLs it contains. The whole turn is
    /// scanned (not just this delta) because streamed answers arrive token-by-token and
    /// a URL is almost never complete inside a single event.
    /// </summary>
    private void EmitAnswer(string text)
    {
        if (string.IsNullOrEmpty(text)) return;
        _turnAnswer.Append(text);
        AppendAssistant(text);
        _ = ShowImagesFromTextAsync(_turnAnswer.ToString(), "Image from response", MaxImagesPerTurn);
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
    
    // ---------------------------------------------------------------- web search
    // Keyless search (DuckDuckGo HTML with a Bing RSS fallback) — the same
    // sources the agent server uses, so no API key is needed for it to work.
    private static readonly HttpClient SearchHttp = new() { Timeout = TimeSpan.FromSeconds(20) };
    private const string SearchUserAgent =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

    private sealed record SearchResult(string Title, string Url, string Snippet);

    /// <summary>True when the local model gave us nothing usable to show.</summary>
    private static bool NeedsWebSearch(string answer)
    {
        var text = (answer ?? string.Empty).Trim();
        if (text.Length == 0) return true;
        // The server already searched the web and answered from it.
        if (text.Contains("checked the web", StringComparison.OrdinalIgnoreCase)) return false;

        const string doubt = @"(i don['’]t know|not sure|unable to answer|cannot determine|can['’]t answer|not enough information|unknown|unsure)";
        if (Regex.Replace(text, @"\s+", " ").Length < 25)
            return Regex.IsMatch(text, doubt, RegexOptions.IgnoreCase);
        return Regex.IsMatch(text, doubt + @"|i do not know|i am not sure|i can['’]t tell", RegexOptions.IgnoreCase);
    }

    private async Task RunWebFallbackIfNoAnswerAsync(CancellationToken token)
    {
        if (_webSearchTriggered || _serverSearchedWeb || _stoppedByUser) return;
        if (!NeedsWebSearch(_turnAnswer.ToString())) return;

        _webSearchTriggered = true;
        AddStatus("ℹ️ The local model had no answer — searching the web…");
        await PerformWebSearchAsync(_lastUserQuestion, token);
    }

    private async Task RunWebFallbackIfServerUnreachableAsync(Exception ex)
    {
        if (_webSearchTriggered || _serverSearchedWeb || _stoppedByUser) return;
        if (ex is not HttpRequestException && ex is not WebException) return;

        _webSearchTriggered = true;
        AddStatus("⚠ Agent server unreachable — answering from the web instead…");
        try
        {
            await PerformWebSearchAsync(_lastUserQuestion, _cts?.Token ?? CancellationToken.None);
        }
        catch (OperationCanceledException) { }
    }

    private async Task PerformWebSearchAsync(string query, CancellationToken token)
    {
        var q = (query ?? string.Empty).Trim();
        if (q.Length == 0)
        {
            EmitAnswer("\nI could not search the web because the question was empty.\n");
            return;
        }

        EmitAnswer($"\n\n🌐 Web search — the local model had no answer for \"{q}\", so I checked the internet:\n\n");

        List<SearchResult>? results = null;
        string? failure = null;
        Func<string, CancellationToken, Task<List<SearchResult>>>[] sources = { SearchDuckDuckGoAsync, SearchBingRssAsync };
        foreach (var source in sources)
        {
            try
            {
                var found = await source(q, token);
                if (found.Count > 0)
                {
                    results = found;
                    break;
                }
                failure = "no results parsed";
            }
            catch (OperationCanceledException) { throw; }
            catch (Exception ex) { failure = ex.Message; }
        }

        if (results == null || results.Count == 0)
        {
            EmitAnswer($"❌ Web search failed: {failure}\n");
            return;
        }

        foreach (var r in results)
            EmitAnswer($"▶ {r.Title}\n{r.Snippet}\n🔗 {r.Url}\n\n");

        ChatScroller.ScrollToEnd();
    }

    private async Task<List<SearchResult>> SearchDuckDuckGoAsync(string query, CancellationToken token)
    {
        using var req = new HttpRequestMessage(HttpMethod.Get,
            "https://html.duckduckgo.com/html/?q=" + Uri.EscapeDataString(query));
        req.Headers.TryAddWithoutValidation("User-Agent", SearchUserAgent);
        req.Headers.TryAddWithoutValidation("Accept-Language", "en-US,en;q=0.9");

        using var resp = await SearchHttp.SendAsync(req, token);
        var status = (int)resp.StatusCode;
        if (status == 403 || status == 429)
            throw new InvalidOperationException("DuckDuckGo blocked this request (rate limit or bot detection).");
        if (!resp.IsSuccessStatusCode)
            throw new InvalidOperationException($"DuckDuckGo request failed (HTTP {status}).");

        var html = await resp.Content.ReadAsStringAsync(token);
        var results = new List<SearchResult>();
        var seen = new HashSet<string>(StringComparer.Ordinal);

        foreach (Match m in Regex.Matches(html,
                     "<a[^>]*class=\"result__a\"[^>]*href=\"([^\"]+)\"[^>]*>([\\s\\S]*?)</a>",
                     RegexOptions.IgnoreCase))
        {
            var url = DecodeDdgUrl(m.Groups[1].Value);
            var title = HtmlToText(m.Groups[2].Value);
            if (url == null || title.Length == 0 || !seen.Add(url)) continue;
            results.Add(new SearchResult(title, url, string.Empty));
        }

        if (results.Count == 0) return results;

        var snippets = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (Match m in Regex.Matches(html,
                     "<a[^>]*class=\"result__snippet\"[^>]*href=\"([^\"]+)\"[^>]*>([\\s\\S]*?)</a>",
                     RegexOptions.IgnoreCase))
        {
            var url = DecodeDdgUrl(m.Groups[1].Value);
            if (url == null) continue;
            var snippet = HtmlToText(m.Groups[2].Value);
            if (snippet.Length > 0 && !snippets.ContainsKey(url)) snippets[url] = snippet;
        }

        for (var i = 0; i < results.Count; i++)
        {
            if (snippets.TryGetValue(results[i].Url, out var snippet)) results[i] = results[i] with { Snippet = snippet };
        }

        return results.Take(8).ToList();
    }

    private async Task<List<SearchResult>> SearchBingRssAsync(string query, CancellationToken token)
    {
        using var req = new HttpRequestMessage(HttpMethod.Get,
            "https://www.bing.com/search?q=" + Uri.EscapeDataString(query) + "&format=rss");
        req.Headers.TryAddWithoutValidation("User-Agent", SearchUserAgent);
        req.Headers.TryAddWithoutValidation("Accept-Language", "en-US,en;q=0.9");

        using var resp = await SearchHttp.SendAsync(req, token);
        var status = (int)resp.StatusCode;
        if (status == 403 || status == 429)
            throw new InvalidOperationException("Bing blocked this request (rate limit or bot detection).");
        if (!resp.IsSuccessStatusCode)
            throw new InvalidOperationException($"Bing request failed (HTTP {status}).");

        var xml = await resp.Content.ReadAsStringAsync(token);
        var results = new List<SearchResult>();
        var seen = new HashSet<string>(StringComparer.Ordinal);

        foreach (Match m in Regex.Matches(xml, "<item>([\\s\\S]*?)</item>", RegexOptions.IgnoreCase))
        {
            var block = m.Groups[1].Value;
            var url = XmlTag(block, "link");
            var title = XmlTag(block, "title");
            if (url.Length == 0 || title.Length == 0 || !seen.Add(url)) continue;
            if (!Uri.TryCreate(url, UriKind.Absolute, out var parsed)) continue;
            if (parsed.Scheme != Uri.UriSchemeHttp && parsed.Scheme != Uri.UriSchemeHttps) continue;
            results.Add(new SearchResult(title, url, XmlTag(block, "description")));
        }

        return results.Take(8).ToList();
    }

    private static string? DecodeDdgUrl(string href)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(href)) return null;
            var full = href.StartsWith("//", StringComparison.Ordinal) ? "https:" + href : href;
            var uri = full.StartsWith("http", StringComparison.OrdinalIgnoreCase)
                ? new Uri(full)
                : new Uri(new Uri("https://duckduckgo.com"), full);

            var uddg = QueryParam(uri, "uddg");
            var raw = string.IsNullOrEmpty(uddg) ? uri.ToString() : uddg;
            if (!Uri.TryCreate(raw, UriKind.Absolute, out var parsed)) return null;
            if (parsed.Scheme != Uri.UriSchemeHttp && parsed.Scheme != Uri.UriSchemeHttps) return null;
            return parsed.ToString();
        }
        catch { return null; }
    }

    private static string? QueryParam(Uri uri, string name)
    {
        foreach (var part in uri.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var kv = part.Split('=', 2);
            if (!string.Equals(kv[0], name, StringComparison.OrdinalIgnoreCase)) continue;
            return kv.Length > 1 ? Uri.UnescapeDataString(kv[1].Replace('+', ' ')) : string.Empty;
        }
        return null;
    }

    private static string XmlTag(string block, string name)
    {
        var m = Regex.Match(block, "<" + name + ">([\\s\\S]*?)</" + name + ">", RegexOptions.IgnoreCase);
        if (!m.Success) return string.Empty;
        var raw = Regex.Replace(m.Groups[1].Value, "<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>", "$1");
        return HtmlToText(raw);
    }

    private static string HtmlToText(string html)
    {
        if (string.IsNullOrEmpty(html)) return string.Empty;
        var decoded = WebUtility.HtmlDecode(Regex.Replace(html, "<[^>]*>", " ")) ?? string.Empty;
        return Regex.Replace(decoded, @"\s+", " ").Trim();
    }

    // ------------------------------------------------------------------ images

    private sealed record ImageResult(string ImageUrl, string ThumbUrl, string PageUrl, string Title);

    /// <summary>Every image URL in <paramref name="text"/>: markdown, raw links, data URIs.</summary>
    private static List<string> ExtractImageUrls(string text)
    {
        var found = new List<string>();
        if (string.IsNullOrEmpty(text)) return found;

        void Add(string? raw)
        {
            var url = CleanImageUrl(raw);
            if (url.Length == 0 || !IsImageUrl(url)) return;
            if (!found.Contains(url, StringComparer.OrdinalIgnoreCase)) found.Add(url);
        }

        foreach (Match m in Regex.Matches(text, @"!\[[^\]]*\]\(([^\)]+)\)", RegexOptions.IgnoreCase))
            Add(m.Groups[1].Value);

        foreach (Match m in Regex.Matches(text,
                     @"(https?://[^\s\)\]>""']+\.(?:png|jpe?g|gif|webp|svg|bmp)(?:\?[^\s\)\]>""']*)?)",
                     RegexOptions.IgnoreCase))
            Add(m.Value);

        foreach (Match m in Regex.Matches(text, @"data:image/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+",
                     RegexOptions.IgnoreCase))
            Add(m.Value);

        return found;
    }

    private static string CleanImageUrl(string? url)
    {
        if (string.IsNullOrWhiteSpace(url)) return string.Empty;
        var u = url.Trim();
        if (u.StartsWith("data:", StringComparison.OrdinalIgnoreCase)) return u;

        // markdown link title: https://…/pic.png "Alt text"
        var space = u.IndexOfAny(new[] { ' ', '\t', '\r', '\n' });
        if (space > 0) u = u[..space];
        return u.Trim().TrimEnd('.', ',', ';', ')', ']', '"', '\'');
    }

    private static bool IsImageUrl(string url)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(url)) return false;
            var target = url.Trim();
            if (target.StartsWith("data:image/", StringComparison.OrdinalIgnoreCase)) return true;
            if (!Uri.TryCreate(target, UriKind.Absolute, out var uri)) return false;
            if (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps) return false;

            var path = uri.AbsolutePath; // query string / fragment stripped
            return path.EndsWith(".png", StringComparison.OrdinalIgnoreCase)
                || path.EndsWith(".jpg", StringComparison.OrdinalIgnoreCase)
                || path.EndsWith(".jpeg", StringComparison.OrdinalIgnoreCase)
                || path.EndsWith(".gif", StringComparison.OrdinalIgnoreCase)
                || path.EndsWith(".webp", StringComparison.OrdinalIgnoreCase)
                || path.EndsWith(".svg", StringComparison.OrdinalIgnoreCase)
                || path.EndsWith(".bmp", StringComparison.OrdinalIgnoreCase);
        }
        catch { return false; }
    }

    /// <summary>Show every not-yet-shown image found in the answer text.</summary>
    private async Task ShowImagesFromTextAsync(string text, string caption, int max)
    {
        foreach (var url in ExtractImageUrls(text))
        {
            if (max-- <= 0) break;
            await ShowImageInChatAsync(url, caption);
        }
    }

    /// <summary>
    /// Renders an image card. The bytes are downloaded here (with a browser UA) so that
    /// failures surface as exceptions instead of WPF's silent async ImageFailed event.
    /// </summary>
    private async Task ShowImageInChatAsync(string imageUrl, string caption, string? altUrl = null, string? openUrl = null)
    {
        if (string.IsNullOrWhiteSpace(imageUrl)) return;
        if (!_shownImages.Add(imageUrl)) return;

        var host = new StackPanel();
        var border = new Border
        {
            Background = Panel,
            BorderBrush = Border,
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(6),
            Padding = new Thickness(8),
            Margin = new Thickness(0, 4, 0, 0),
            Child = host,
        };
        host.Children.Add(new TextBlock
        {
            Text = "⏳ Loading image…",
            Foreground = Muted,
            FontStyle = FontStyles.Italic,
            FontSize = 12,
        });
        if (!string.IsNullOrEmpty(caption))
            host.Children.Add(MakeCaption(caption));
        ChatPanel.Children.Add(border);
        ChatScroller.ScrollToEnd();

        try
        {
            var bitmap = await LoadImageAsync(imageUrl, altUrl, _cts?.Token ?? CancellationToken.None);
            host.Children.Clear();

            var image = new System.Windows.Controls.Image
            {
                Source = bitmap,
                Stretch = System.Windows.Media.Stretch.Uniform,
                MaxWidth = 720,
                MaxHeight = 400,
            };
            var target = !string.IsNullOrEmpty(openUrl) ? openUrl : imageUrl;
            if (!string.IsNullOrEmpty(target))
            {
                image.Cursor = Cursors.Hand;
                image.MouseLeftButtonUp += (_, _) => OpenInBrowser(target);
                image.ToolTip = "Click to open the source";
            }
            host.Children.Add(image);
            if (!string.IsNullOrEmpty(caption)) host.Children.Add(MakeCaption(caption));
        }
        catch (OperationCanceledException)
        {
            ChatPanel.Children.Remove(border);
            return;
        }
        catch (Exception ex)
        {
            host.Children.Clear();
            host.Children.Add(new TextBlock
            {
                Text = $"🖼 Image unavailable ({ex.Message})",
                Foreground = Muted,
                FontStyle = FontStyles.Italic,
                TextWrapping = TextWrapping.Wrap,
            });
            var target = !string.IsNullOrEmpty(openUrl) ? openUrl : imageUrl;
            host.Children.Add(MakeCaption($"🔗 {target}"));
        }

        ChatScroller.ScrollToEnd();
    }

    private static TextBlock MakeCaption(string caption) => new()
    {
        Text = caption,
        Foreground = Muted,
        FontSize = 12,
        TextWrapping = TextWrapping.Wrap,
        Margin = new Thickness(0, 4, 0, 0),
    };

    private static async Task<System.Windows.Media.Imaging.BitmapImage> LoadImageAsync(
        string url, string? altUrl, CancellationToken token)
    {
        Exception? first = null;
        foreach (var candidate in new[] { url, altUrl }.Where(u => !string.IsNullOrEmpty(u)).Select(u => u!))
        {
            try
            {
                var bytes = await DownloadImageBytesAsync(candidate, token);
                return DecodeImage(bytes);
            }
            catch (OperationCanceledException) { throw; }
            catch (Exception ex) { first ??= ex; }
        }
        throw first ?? new InvalidOperationException("no image url");
    }

    private static async Task<byte[]> DownloadImageBytesAsync(string url, CancellationToken token)
    {
        if (url.StartsWith("data:", StringComparison.OrdinalIgnoreCase))
        {
            var comma = url.IndexOf(',');
            if (comma < 0) throw new InvalidOperationException("malformed data URI");
            var meta = url[..comma];
            var payload = url[(comma + 1)..];
            return meta.Contains("base64", StringComparison.OrdinalIgnoreCase)
                ? Convert.FromBase64String(payload)
                : Encoding.UTF8.GetBytes(Uri.UnescapeDataString(payload));
        }

        using var req = new HttpRequestMessage(HttpMethod.Get, url);
        req.Headers.TryAddWithoutValidation("User-Agent", SearchUserAgent);
        req.Headers.TryAddWithoutValidation("Accept", "image/avif,image/webp,image/apng,image/*,*/*;q=0.8");
        if (Uri.TryCreate(url, UriKind.Absolute, out var parsed))
            req.Headers.TryAddWithoutValidation("Referer", parsed.GetLeftPart(UriPartial.Authority));

        using var resp = await SearchHttp.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, token);
        if (!resp.IsSuccessStatusCode)
            throw new InvalidOperationException($"HTTP {(int)resp.StatusCode}");

        var mediaType = resp.Content.Headers.ContentType?.MediaType ?? string.Empty;
        if (mediaType.StartsWith("text/", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("not an image");

        var bytes = await resp.Content.ReadAsByteArrayAsync(token);
        if (bytes.Length == 0) throw new InvalidOperationException("empty response");
        if (bytes.Length > 15 * 1024 * 1024) throw new InvalidOperationException("image too large");
        return bytes;
    }

    private static System.Windows.Media.Imaging.BitmapImage DecodeImage(byte[] bytes)
    {
        using var ms = new MemoryStream(bytes);
        var bitmap = new System.Windows.Media.Imaging.BitmapImage();
        bitmap.BeginInit();
        bitmap.CacheOption = System.Windows.Media.Imaging.BitmapCacheOption.OnLoad;
        bitmap.StreamSource = ms;
        bitmap.EndInit();
        bitmap.Freeze();
        return bitmap;
    }

    private static void OpenInBrowser(string url)
    {
        try
        {
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(url) { UseShellExecute = true });
        }
        catch { }
    }

    // ------------------------------------------------------- related images

    /// <summary>
    /// When the turn pulled content from the web, look up a few images that match the
    /// question and show them — Bing's image results carry the media URL, a CDN
    /// thumbnail and the source page, all without an API key.
    /// </summary>
    private async Task ShowRelatedImagesAsync(CancellationToken token)
    {
        if (_stoppedByUser) return;
        if (!_serverSearchedWeb && !_webSearchTriggered) return;

        var query = _lastUserQuestion.Trim();
        if (query.Length == 0) return;

        var want = MaxImagesPerTurn - _shownImages.Count;
        if (want <= 0) return;

        try
        {
            AddStatus("🔎 Finding related images…");
            var images = await SearchImagesAsync(query, token);
            foreach (var img in images.Take(want))
            {
                var display = !string.IsNullOrEmpty(img.ThumbUrl) ? img.ThumbUrl : img.ImageUrl;
                var alt = !string.IsNullOrEmpty(img.ImageUrl) ? img.ImageUrl : null;
                var open = !string.IsNullOrEmpty(img.PageUrl) ? img.PageUrl : img.ImageUrl;
                var caption = string.IsNullOrEmpty(img.Title) ? "Related image" : $"🖼 {img.Title}";
                await ShowImageInChatAsync(display, caption, alt, open);
            }
        }
        catch (OperationCanceledException) { }
        catch (Exception ex) { AddStatus($"⚠ Related image search failed: {ex.Message}"); }
    }

    private async Task<List<ImageResult>> SearchImagesAsync(string query, CancellationToken token)
    {
        using var req = new HttpRequestMessage(HttpMethod.Get,
            "https://www.bing.com/images/search?q=" + Uri.EscapeDataString(query) + "&form=HDRSC2");
        req.Headers.TryAddWithoutValidation("User-Agent", SearchUserAgent);
        req.Headers.TryAddWithoutValidation("Accept-Language", "en-US,en;q=0.9");

        using var resp = await SearchHttp.SendAsync(req, token);
        if (!resp.IsSuccessStatusCode)
            throw new InvalidOperationException($"image search failed (HTTP {(int)resp.StatusCode})");

        var html = await resp.Content.ReadAsStringAsync(token);
        var results = new List<ImageResult>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        void Push(string imageUrl, string thumbUrl, string pageUrl, string title)
        {
            var key = imageUrl.Length > 0 ? imageUrl : thumbUrl;
            if (key.Length == 0 || !seen.Add(key)) return;
            results.Add(new ImageResult(imageUrl, thumbUrl, pageUrl, title));
        }

        // Bing stores a JSON blob in the m="…" attribute of each result anchor.
        foreach (Match m in Regex.Matches(html, @"m=""([^""]*murl[^""]*)""", RegexOptions.IgnoreCase))
        {
            var json = WebUtility.HtmlDecode(m.Groups[1].Value);
            if (!json.StartsWith("{", StringComparison.Ordinal)) continue;
            try
            {
                using var doc = JsonDocument.Parse(json);
                var root = doc.RootElement;
                Push(JsonStr(root, "murl"), JsonStr(root, "turl"), JsonStr(root, "purl"), JsonStr(root, "t"));
            }
            catch { }
            if (results.Count >= 10) break;
        }

        if (results.Count == 0)
        {
            // Fallback: bare murl values encoded in the HTML.
            foreach (Match m in Regex.Matches(html, @"&quot;murl&quot;:&quot;(.*?)&quot;", RegexOptions.IgnoreCase))
            {
                var url = WebUtility.HtmlDecode(m.Groups[1].Value);
                if (url.StartsWith("http", StringComparison.OrdinalIgnoreCase)) Push(url, string.Empty, string.Empty, string.Empty);
                if (results.Count >= 10) break;
            }
        }

        return results;
    }

    private static string JsonStr(JsonElement el, string key)
    {
        try
        {
            if (el.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String)
                return v.GetString() ?? string.Empty;
        }
        catch { }
        return string.Empty;
    }
    

}