using System;
using System.Drawing;
using System.IO;
using System.Windows.Forms;

namespace AgentMath {
    internal sealed class FormulaWindow : Form {
        private Bitmap image;
        private readonly IntPtr terminalOwner;
        internal readonly string ImageId;
        internal readonly string Kind;
        private readonly int offsetY;
        internal long OwnerHwnd { get { return terminalOwner.ToInt64(); } }
        internal int ImageWidth { get { return image.Width; } }
        internal int ImageHeight { get { return image.Height; } }
        protected override bool ShowWithoutActivation { get { return true; } }
        protected override CreateParams CreateParams {
            get { var value = base.CreateParams; value.ExStyle |= 0x00080000 | 0x20 | 0x80 | 0x08000000; return value; }
        }
        internal FormulaWindow(IntPtr owner, WorkerFormula formula, Color background) {
            terminalOwner = owner;
            if (formula.png == null || formula.png.Length > 3 * 1024 * 1024) throw new Exception("Invalid image size");
            using (var bytes = new MemoryStream(Convert.FromBase64String(formula.png)))
            using (var decoded = Image.FromStream(bytes)) {
                if (decoded.Width != formula.width || decoded.Height != formula.height ||
                    decoded.Width > 8192 || decoded.Height > 4096) throw new Exception("Invalid image dimensions");
                image = new Bitmap(decoded);
            }
            ImageId = formula.imageId;
            Kind = formula.kind; offsetY = formula.offsetY;
            FormBorderStyle = FormBorderStyle.None; ShowInTaskbar = false;
            StartPosition = FormStartPosition.Manual; BackColor = background; DoubleBuffered = true;
            var handle = Handle;
            Native.SetWindowLongPtr(handle, -8, owner);
            Native.SetLayeredWindowAttributes(handle, 0, 255, 2);
        }
        internal void EnsureAboveOwner() {
            // A native click can place one owned overlay behind the terminal
            // without changing Form.Visible. Repair only that ordering, keeping
            // the terminal's position and keyboard focus intact.
            if (!Visible || Native.GetForegroundWindow() != terminalOwner) return;
            if (Native.IsBehindOwner(Handle, terminalOwner) && Native.GetForegroundWindow() == terminalOwner)
                Native.SetWindowPos(Handle, IntPtr.Zero, 0, 0, 0, 0, 0x213); // NOOWNERZORDER | NOACTIVATE | NOMOVE | NOSIZE
        }
        protected override void OnPaint(PaintEventArgs args) {
            base.OnPaint(args);
            if (image != null) args.Graphics.DrawImageUnscaled(image, Kind == "inline" ? 0 : (ClientSize.Width - image.Width) / 2,
                Kind == "inline" ? offsetY : (ClientSize.Height - image.Height) / 2);
        }
        protected override void WndProc(ref Message message) {
            if (message.Msg == 0x84) { message.Result = new IntPtr(-1); return; } // HTTRANSPARENT
            if (message.Msg == 0x21) { message.Result = new IntPtr(3); return; } // MA_NOACTIVATE
            base.WndProc(ref message);
        }
        protected override void Dispose(bool disposing) {
            if (disposing && image != null) { image.Dispose(); image = null; }
            base.Dispose(disposing);
        }
    }
}
