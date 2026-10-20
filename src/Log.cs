using System;
using System.IO;

namespace QuickLook.Plugin.GpxViewer;

/// <summary>
/// One line per previewed file in %LOCALAPPDATA%\GpxViewer\log.txt, so problems can be
/// diagnosed without a debugger. Rotated at 1 MB; never throws.
/// </summary>
internal static class Log
{
    private const long MaxBytes = 1024 * 1024;
    private static readonly object Gate = new();

    private static readonly string FilePath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "GpxViewer", "log.txt");

    public static void Write(string message)
    {
        try
        {
            lock (Gate)
            {
                Directory.CreateDirectory(Path.GetDirectoryName(FilePath));
                var info = new FileInfo(FilePath);
                if (info.Exists && info.Length > MaxBytes)
                {
                    File.Copy(FilePath, FilePath + ".old", true);
                    File.Delete(FilePath);
                }
                File.AppendAllText(FilePath, $"{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff} {message}{Environment.NewLine}");
            }
        }
        catch
        {
            // Logging must never break a preview.
        }
    }
}
