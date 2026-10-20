using QuickLook.Common.Plugin;
using System.IO;
using System.Windows;

namespace QuickLook.Plugin.GpxViewer;

public class Plugin : IViewer
{
    private GpxPanel _panel;

    // Above the text viewer, which would otherwise show .gpx files as XML source.
    public int Priority => 10;

    public void Init()
    {
    }

    public bool CanHandle(string path) => !Directory.Exists(path) && GpxDetector.IsGpx(path);

    public void Prepare(string path, ContextObject context)
    {
        context.Title = Path.GetFileName(path);
        context.Theme = Themes.Dark;

        var area = SystemParameters.WorkArea;
        context.PreferredSize = new Size(System.Math.Min(1200, area.Width * 0.8), System.Math.Min(800, area.Height * 0.8));
    }

    public void View(string path, ContextObject context)
    {
        _panel = new GpxPanel();
        _panel.Finished += _ => context.IsBusy = false;
        context.ViewerContent = _panel;
        _panel.Load(path);
    }

    public void Cleanup()
    {
        _panel?.Dispose();
        _panel = null;
    }
}
