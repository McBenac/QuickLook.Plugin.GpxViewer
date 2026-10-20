using System;
using System.IO;
using System.Xml;

namespace QuickLook.Plugin.GpxViewer;

/// <summary>
/// Decides whether a file is a GPX document: a .gpx file whose root element is &lt;gpx&gt;.
/// Only the start of the file is read, so huge tracks are accepted without parsing them here;
/// the web viewer parses the whole file and reports errors further in.
/// </summary>
internal static class GpxDetector
{
    private const int HeadBytes = 64 * 1024;

    public static bool IsGpx(string path)
    {
        if (!path.EndsWith(".gpx", StringComparison.OrdinalIgnoreCase))
            return false;

        try
        {
            var head = ReadHead(path);
            if (head.Length == 0)
                return false;

            var settings = new XmlReaderSettings
            {
                DtdProcessing = DtdProcessing.Ignore,
                XmlResolver = null,
                IgnoreComments = true,
                IgnoreProcessingInstructions = true,
                IgnoreWhitespace = true,
            };
            using var reader = XmlReader.Create(new MemoryStream(head), settings);
            return reader.MoveToContent() == XmlNodeType.Element && reader.LocalName == "gpx";
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or XmlException)
        {
            return false;
        }
    }

    private static byte[] ReadHead(string path)
    {
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        var buffer = new byte[(int)Math.Min(HeadBytes, stream.Length)];
        var read = 0;
        while (read < buffer.Length)
        {
            var n = stream.Read(buffer, read, buffer.Length - read);
            if (n == 0)
                break;
            read += n;
        }
        if (read < buffer.Length)
            Array.Resize(ref buffer, read);
        return buffer;
    }
}
