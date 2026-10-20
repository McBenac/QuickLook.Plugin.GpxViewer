using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;
using QuickLook.Common.Helpers;
using System;
using System.Diagnostics;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Threading;

namespace QuickLook.Plugin.GpxViewer;

/// <summary>
/// Hosts the bundled web viewer (viewer/index.html) in WebView2. The viewer files and the folder of
/// the GPX file are exposed on two virtual hosts; the page reports back "ready\t&lt;summary&gt;" or
/// "error:&lt;text&gt;".
/// </summary>
internal sealed class GpxPanel : UserControl, IDisposable
{
    private const string AppHost = "app.gpxviewer.example";
    private const string FileHost = "file.gpxviewer.example";
    private static readonly TimeSpan LoadTimeout = TimeSpan.FromSeconds(20);

    private static readonly string ViewerFolder =
        Path.Combine(Path.GetDirectoryName(typeof(GpxPanel).Assembly.Location), "viewer");

    private readonly Stopwatch _clock = Stopwatch.StartNew();
    private readonly DispatcherTimer _timeout;
    private string _path;
    private WebView2 _webView;
    private bool _finished;

    public GpxPanel()
    {
        Background = new SolidColorBrush(Color.FromRgb(24, 24, 24));
        _timeout = new DispatcherTimer { Interval = LoadTimeout };
        _timeout.Tick += (_, _) => Fail("Timed out while loading the preview.");
    }

    /// <summary>Raised once: null when the track is shown, otherwise the error text.</summary>
    public event Action<string> Finished;

    /// <summary>Step-by-step trace for the test harness; silent inside QuickLook.</summary>
    internal static Action<string> Trace = _ => { };

    public void Load(string path)
    {
        _path = path;

        if (!IsWebView2Available())
        {
            Fail("Microsoft Edge WebView2 Runtime is required to show GPX previews.");
            return;
        }

        _webView = new WebView2
        {
            CreationProperties = new CoreWebView2CreationProperties
            {
                // Also keeps the chosen map layer (localStorage) between previews.
                UserDataFolder = Path.Combine(SettingHelper.LocalDataPath, "GpxViewer_WebView2"),
            },
            DefaultBackgroundColor = System.Drawing.Color.FromArgb(255, 24, 24, 24),
        };
        _webView.CoreWebView2InitializationCompleted += OnInitialized;
        _webView.NavigationCompleted += OnNavigationCompleted;
        Content = _webView;
        _timeout.Start();
        Trace("WebView2 runtime " + CoreWebView2Environment.GetAvailableBrowserVersionString());
        _ = _webView.EnsureCoreWebView2Async();
    }

    private void OnInitialized(object sender, CoreWebView2InitializationCompletedEventArgs e)
    {
        Trace($"WebView2 initialized: success={e.IsSuccess} {e.InitializationException?.Message}");
        if (_webView == null)
            return; // preview already closed

        if (!e.IsSuccess)
        {
            Fail("Could not start WebView2: " + e.InitializationException?.Message);
            return;
        }

        try
        {
            var core = _webView.CoreWebView2;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.AreBrowserAcceleratorKeysEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.IsZoomControlEnabled = false;
            core.NewWindowRequested += OnNewWindowRequested;
            core.NavigationStarting += (_, args) =>
            {
                // The page never navigates away: https links (map attribution) open in the default browser,
                // anything else (e.g. a file dropped on the view) is blocked.
                if (Uri.TryCreate(args.Uri, UriKind.Absolute, out var uri) && uri.Host == AppHost)
                    return;
                args.Cancel = true;
                OpenInBrowser(args.Uri);
            };
            core.WebMessageReceived += OnWebMessage;

            // Allow = served as if with "Access-Control-Allow-Origin: *", so the page (another origin) can fetch
            // the file. The page treats everything in the file as text and has a Content-Security-Policy.
            core.SetVirtualHostNameToFolderMapping(AppHost, ViewerFolder, CoreWebView2HostResourceAccessKind.Allow);
            core.SetVirtualHostNameToFolderMapping(FileHost, Path.GetDirectoryName(_path),
                CoreWebView2HostResourceAccessKind.Allow);

            _webView.Source = new Uri(BuildViewerUrl(_path));
            Trace("navigating to " + _webView.Source);
        }
        catch (Exception ex)
        {
            Fail("Could not open the preview: " + ex.Message);
        }
    }

    internal static string BuildViewerUrl(string path)
    {
        var name = Path.GetFileName(path);
        var source = $"https://{FileHost}/{Uri.EscapeDataString(name)}";
        return $"https://{AppHost}/index.html?src={Uri.EscapeDataString(source)}&name={Uri.EscapeDataString(name)}";
    }

    private static void OnNewWindowRequested(object sender, CoreWebView2NewWindowRequestedEventArgs args)
    {
        args.Handled = true;
        OpenInBrowser(args.Uri);
    }

    /// <summary>Links in the map attribution open in the default browser, never inside the preview.</summary>
    private static void OpenInBrowser(string link)
    {
        if (Uri.TryCreate(link, UriKind.Absolute, out var uri) && uri.Scheme == Uri.UriSchemeHttps)
        {
            try
            {
                Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true });
            }
            catch (Exception ex)
            {
                Trace("could not open link: " + ex.Message);
            }
        }
    }

    private void OnNavigationCompleted(object sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        Trace($"navigation completed: success={e.IsSuccess} status={e.WebErrorStatus}");
        if (!e.IsSuccess && e.WebErrorStatus != CoreWebView2WebErrorStatus.OperationCanceled)
            Fail("Could not load the viewer: " + e.WebErrorStatus);
    }

    private void OnWebMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        if (!Uri.TryCreate(e.Source, UriKind.Absolute, out var origin) || origin.Host != AppHost)
            return;

        string message;
        try
        {
            message = e.TryGetWebMessageAsString();
        }
        catch (ArgumentException)
        {
            return;
        }

        Trace("message from viewer: " + message);
        if (message == "ready" || message.StartsWith("ready\t", StringComparison.Ordinal))
            Finish(null, message.Length > 6 ? message.Substring(6) : "");
        else if (message.StartsWith("error:", StringComparison.Ordinal))
            Finish(message.Substring("error:".Length), "");
    }

    /// <summary>Shows the error in place of the viewer and ends loading.</summary>
    private void Fail(string error)
    {
        if (_finished)
            return;
        ShowMessage(error);
        Finish(error, "");
    }

    private void Finish(string error, string summary)
    {
        if (_finished)
            return;
        _finished = true;
        _timeout.Stop();

        var name = Path.GetFileName(_path);
        Log.Write(error == null
            ? $"OK    {name} {summary} {_clock.ElapsedMilliseconds} ms"
            : $"ERROR {name} {_clock.ElapsedMilliseconds} ms: {error}");

        Finished?.Invoke(error);
    }

    private void ShowMessage(string text)
    {
        // The WebView2 (if any) is disposed in Dispose(); it may still be raising the current event.
        Content = new TextBlock
        {
            Text = text,
            Foreground = Brushes.Gainsboro,
            TextWrapping = TextWrapping.Wrap,
            HorizontalAlignment = HorizontalAlignment.Center,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(24),
        };
    }

    private static bool IsWebView2Available()
    {
        try
        {
            return !string.IsNullOrEmpty(CoreWebView2Environment.GetAvailableBrowserVersionString());
        }
        catch (WebView2RuntimeNotFoundException)
        {
            return false;
        }
    }

    internal System.Threading.Tasks.Task CapturePngAsync(Stream output) =>
        _webView.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, output);

    public void Dispose()
    {
        _finished = true; // no callbacks after the preview is closed
        _timeout.Stop();
        if (_webView != null)
        {
            _webView.CoreWebView2InitializationCompleted -= OnInitialized;
            _webView.NavigationCompleted -= OnNavigationCompleted;
            _webView.Dispose();
            _webView = null;
        }
    }
}
