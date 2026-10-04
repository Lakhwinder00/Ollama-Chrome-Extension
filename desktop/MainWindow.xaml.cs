using System;
using System.IO;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;

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

    public MainWindow()
    {
        InitializeComponent();
        Loaded += async (_, _) =>
        {
            await RefreshModelsAsync();
            await CheckHealthAsync();
        };
    }

    private string ServerUrl => ServerBox.Text.Trim();

    // ---------------------------------------------------------------- server

    private async Task RefreshModelsAsync()
    {
        try
        {
            var json = await Http.GetStringAsync(ServerUrl + "/models");
            using var doc = JsonDocument.Parse(json);
            ModelCombo.Items.Clear();
            foreach (var m in doc.RootElement.GetProperty("models").EnumerateArray())
                ModelCombo.Items.Add(m.GetString());
            if (ModelCombo.Items.Count > 0 && ModelCombo.SelectedIndex < 0)
                ModelCombo.SelectedIndex = 0;
        }
        catch
        {
            ConnLabel.Text = "● server offline";
            ConnLabel.Foreground = Err;
        }
    }

    private async Task CheckHealthAsync()
    {
        try
        {
            var json = await Http.GetStringAsync(ServerUrl + "/health");
            using var doc = JsonDocument.Parse(json);
            var ok = doc.RootElement.GetProperty("ok").GetBoolean();
            ConnLabel.Text = ok ? "● connected" : "● ollama unreachable";
            ConnLabel.Foreground = ok ? Ok : Err;
        }
        catch
        {
            ConnLabel.Text = "● server offline";
            ConnLabel.Foreground = Err;
        }
    }

    private async void RefreshModels_Click(object sender, RoutedEventArgs e) => await RefreshModelsAsync();

    private async void SetProject_Click(object sender, RoutedEventArgs e)
    {
        var root = ProjectBox.Text.Trim();
        if (root.Length == 0) return;
        try
        {
            var resp = await Http.PostAsync(ServerUrl + "/project",
                new StringContent(JsonSerializer.Serialize(new { root }), Encoding.UTF8, "application/json"));
            var body = await resp.Content.ReadAsStringAsync();
            using var doc = JsonDocument.Parse(body);
            if (doc.RootElement.GetProperty("ok").GetBoolean())
                AddStatus("Project set: " + doc.RootElement.GetProperty("root").GetString());
            else
                AddStatus("✖ " + doc.RootElement.GetProperty("error").GetString());
        }
        catch (Exception ex)
        {
            AddStatus("✖ " + ex.Message);
        }
    }

    // ------------------------------------------------------------------ chat

    private async void Send_Click(object sender, RoutedEventArgs e) => await SendAsync();

    private async void InputBox_KeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Enter)
        {
            e.Handled = true;
            await SendAsync();
        }
    }

    private async Task SendAsync()
    {
        var text = InputBox.Text.Trim();
        if (text.Length == 0 || _cts != null) return;
        InputBox.Text = "";
        AddUser(text);
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

    private async void Stop_Click(object sender, RoutedEventArgs e)
    {
        if (_cts == null) return;
        try
        {
            if (_sessionId != null)
                await Http.PostAsync(ServerUrl + "/stop",
                    new StringContent(JsonSerializer.Serialize(new { sessionId = _sessionId }), Encoding.UTF8, "application/json"));
        }
        catch { }
        _cts.Cancel();
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
                if (TryStr(data, "content", out var c)) AppendAssistant(c);
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
}
