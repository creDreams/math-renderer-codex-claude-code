using System;
using System.Globalization;

namespace AgentMath {
    internal static class MathPalette {
        private static double Linear(double channel) {
            return channel <= 0.04045 ? channel / 12.92 : Math.Pow((channel + 0.055) / 1.055, 2.4);
        }
        internal static double Luminance(string hex) {
            int value = Int32.Parse(hex.Substring(1), NumberStyles.HexNumber, CultureInfo.InvariantCulture);
            return 0.2126 * Linear(((value >> 16) & 255) / 255.0) +
                0.7152 * Linear(((value >> 8) & 255) / 255.0) + 0.0722 * Linear((value & 255) / 255.0);
        }
        internal static double Contrast(string first, string second) {
            double a = Luminance(first), b = Luminance(second);
            return (Math.Max(a, b) + 0.05) / (Math.Min(a, b) + 0.05);
        }
        internal static string Foreground(string background) {
            // A page's first underscore can belong to prose or coloured code.
            // Pick one neutral, readable ink from the actual terminal background
            // instead. No colour depends on scroll position or token styling.
            if (Contrast("#cccccc", background) >= 4.5) return "#cccccc";
            if (Contrast("#202020", background) >= 4.5) return "#202020";
            return Contrast("#ffffff", background) >= Contrast("#000000", background) ? "#ffffff" : "#000000";
        }
    }
}
