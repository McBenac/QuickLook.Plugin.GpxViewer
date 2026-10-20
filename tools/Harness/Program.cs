using QuickLook.Plugin.GpxViewer;
using System;
using System.IO;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Threading;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length >= 2 && args[0] == "detect")
            return Detect(args);
        if (args.Length >= 3 && args[0] == "render")
            return Render(args[1], args[2], args.Length > 3 ? int.Parse(args[3]) : 30);

        Console.WriteLine("Usage: GpxViewer.Harness detect <file>...");
        Console.WriteLine("       GpxViewer.Harness render <file> <out.png> [timeoutSeconds]");
        return 2;
    }

    private static int Detect(string[] args)
    {
        for (var i = 1; i < args.Length; i++)
            Console.WriteLine($"{(GpxDetector.IsGpx(args[i]) ? "GPX" : "-")}\t{Path.GetFileName(args[i])}");
        return 0;
    }

    private static int Render(string file, string png, int timeoutSeconds)
    {
        if (!GpxDetector.IsGpx(file))
        {
            Console.WriteLine("NOT HANDLED " + file);
            return 3;
        }

        var clock = System.Diagnostics.Stopwatch.StartNew();
        GpxPanel.Trace = line => Console.WriteLine($"[{clock.ElapsedMilliseconds,6} ms] {line}");
        var exitCode = 1;
        var app = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
        var panel = new GpxPanel();
        var window = new Window { Width = 1200, Height = 800, Title = "GpxViewer harness", Content = panel };
        var timeout = new DispatcherTimer { Interval = TimeSpan.FromSeconds(timeoutSeconds) };
        timeout.Tick += (_, _) =>
        {
            Console.WriteLine("TIMEOUT");
            app.Shutdown();
        };

        panel.Finished += async error =>
        {
            timeout.Stop();
            if (error != null)
            {
                Console.WriteLine("ERROR " + error);
                app.Shutdown();
                return;
            }

            await Task.Delay(1500); // let the map tiles load
            using (var output = File.Create(png))
                await panel.CapturePngAsync(output);
            Console.WriteLine("OK " + png);
            exitCode = 0;
            app.Shutdown();
        };

        window.Loaded += (_, _) =>
        {
            GpxPanel.Trace("window loaded");
            timeout.Start();
            panel.Load(Path.GetFullPath(file));
        };
        app.Run(window);
        return exitCode;
    }
}
