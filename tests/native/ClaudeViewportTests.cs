using System;
using System.IO;
using System.Web.Script.Serialization;
using AgentMath;

internal static class ClaudeViewportTests {
    public sealed class Layout { public string name; public string[] rows; public int startRow, endRow; }
    static int Main(string[] args) {
        var fixtures = new JavaScriptSerializer().Deserialize<Layout[]>(File.ReadAllText(args[0]));
        int count = 0;
        foreach (var fixture in fixtures) {
            var body = ClaudeViewport.Body(fixture.rows);
            if (fixture.startRow < 0 ? body != null : body == null || body.startRow != fixture.startRow || body.endRow != fixture.endRow)
                throw new Exception("Claude viewport mismatch: " + fixture.name);
            count++; Console.WriteLine("PASS shared Claude viewport: " + fixture.name);
        }
        for (int r = 0; r < 256; r += 17) for (int g = 0; g < 256; g += 17) for (int b = 0; b < 256; b += 17) {
            string background = "#" + r.ToString("x2") + g.ToString("x2") + b.ToString("x2");
            string foreground = MathPalette.Foreground(background);
            if (MathPalette.Contrast(foreground, background) < 4.5) throw new Exception("Insufficient math contrast: " + background);
            if (foreground.Substring(1, 2) != foreground.Substring(3, 2) || foreground.Substring(1, 2) != foreground.Substring(5, 2))
                throw new Exception("Math colour must be neutral");
            count++;
        }
        if (MathPalette.Foreground("#0c0c0c") != "#cccccc" || MathPalette.Foreground("#ffffff") != "#202020")
            throw new Exception("Default dark/light math palette changed");
        Console.WriteLine(count + " shared viewport and math palette checks passed");
        return 0;
    }
}
