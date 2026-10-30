// Private Windows UI Automation + bounded input helper. JSON stdin/stdout only.
// No shell, arbitrary processes, filesystem operations, clipboard or elevation.
using System;
using System.IO;
using System.Linq;
using System.Text;
using System.Drawing;
using System.Drawing.Imaging;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using System.Windows.Automation;
class KaiComputer {
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort vk, scan; public uint flags, time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public MOUSEINPUT mouse; [FieldOffset(0)] public KEYBDINPUT key; }
    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION data; }
    delegate bool EnumProc(IntPtr hwnd, IntPtr param);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr param);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int command);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT point);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT point);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern uint SendInput(uint count, INPUT[] input, int size);
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 8 * 1024 * 1024 };
    static readonly Dictionary<string, AutomationElement> Elements = new Dictionary<string, AutomationElement>();
    static readonly Dictionary<string, string> Names = new Dictionary<string, string>();
    static readonly Dictionary<string, System.Windows.Rect> Bounds = new Dictionary<string, System.Windows.Rect>();
    static IntPtr Target; static Rectangle Area; static string Frame = ""; static int IgnorePid;
    static string Text(Dictionary<string, object> r, string key, string fallback = "") { return r.ContainsKey(key) ? Convert.ToString(r[key]) : fallback; }
    static int Number(Dictionary<string, object> r, string key, int fallback = 0) { return r.ContainsKey(key) ? Convert.ToInt32(r[key]) : fallback; }
    static string Short(string value, int max = 180) { return value == null ? "" : value.Substring(0, Math.Min(max, value.Length)); }
    static string Tail(string value, int max = 240) { return value.Length <= max ? value : value.Substring(value.Length - max); }
    static string Title(IntPtr hwnd) { var text = new StringBuilder(512); GetWindowText(hwnd, text, text.Capacity); return text.ToString(); }
    static string ProcessName(IntPtr hwnd) { uint pid; GetWindowThreadProcessId(hwnd, out pid); try { return Process.GetProcessById((int)pid).ProcessName; } catch { return ""; } }
    static bool Own(IntPtr hwnd) { uint pid; GetWindowThreadProcessId(hwnd, out pid); return pid == IgnorePid || pid == Process.GetCurrentProcess().Id; }
    static bool Blocked(IntPtr hwnd) {
        return new [] { "cmd", "powershell", "pwsh", "windowsterminal", "wt", "regedit", "logonui", "consent", "credentialuibroker", "taskmgr" }.Contains(ProcessName(hwnd).ToLowerInvariant());
    }
    static List<IntPtr> Windows() {
        var windows = new List<IntPtr>();
        EnumWindows((hwnd, p) => {
            RECT r; GetWindowRect(hwnd, out r);
            if (IsWindowVisible(hwnd) && !Own(hwnd) && !Blocked(hwnd) && r.Right - r.Left >= 100 && r.Bottom - r.Top >= 60 && Title(hwnd).Length > 0) windows.Add(hwnd);
            return windows.Count < 30;
        }, IntPtr.Zero); return windows;
    }
    static Rectangle VisibleArea(IntPtr hwnd) {
        RECT r; if (!GetWindowRect(hwnd, out r)) throw new Exception("That window is no longer available.");
        var area = Rectangle.Intersect(Rectangle.FromLTRB(r.Left, r.Top, r.Right, r.Bottom), System.Windows.Forms.SystemInformation.VirtualScreen);
        if (area.Width < 50 || area.Height < 40 || IsIconic(hwnd)) throw new Exception("Restore that window first so KAI can see it.");
        return area;
    }
    static object Box(System.Windows.Rect r) { return new { x = Math.Round((r.X - Area.X) * 1000 / Area.Width), y = Math.Round((r.Y - Area.Y) * 1000 / Area.Height), width = Math.Round(r.Width * 1000 / Area.Width), height = Math.Round(r.Height * 1000 / Area.Height) }; }
    static object Look(Dictionary<string, object> request) {
        var windows = Windows(); if (windows.Count == 0) throw new Exception("Open the app or browser window you want KAI to use.");
        var wanted = Text(request, "window");
        Target = wanted.Length > 0 ? windows.FirstOrDefault(w => w.ToInt64().ToString() == wanted) : windows.FirstOrDefault(w => w == GetForegroundWindow());
        if (Target == IntPtr.Zero) Target = wanted.Length > 0 ? IntPtr.Zero : windows.FirstOrDefault(w => !IsIconic(w));
        if (Target == IntPtr.Zero) throw new Exception("That window is no longer visible. Look again.");
        Area = VisibleArea(Target); Elements.Clear(); Names.Clear(); Bounds.Clear(); Frame = Guid.NewGuid().ToString("N").Substring(0, 12);
        bool accessible = !request.ContainsKey("accessibility") || !(request["accessibility"] is bool) || (bool)request["accessibility"];
        var pending = new Queue<Tuple<AutomationElement, string, int>>();
        var items = new List<object>(); if (accessible) pending.Enqueue(Tuple.Create(AutomationElement.FromHandle(Target), "", 0)); var clock = Stopwatch.StartNew(); int walked = 0;
        while (pending.Count > 0 && walked++ < 900 && items.Count < 180 && clock.ElapsedMilliseconds < 3500) {
            var entry = pending.Dequeue(); var e = entry.Item1;
            try {
                var c = e.Current; if (c.IsOffscreen) continue;
                var rect = c.BoundingRectangle; string name = Short(c.Name), role = c.ControlType.ProgrammaticName.Replace("ControlType.", "");
                bool password = c.IsPassword; string context = Tail(entry.Item2);
                if (!rect.IsEmpty && rect.Width > 0 && rect.Height > 0 && (name.Length > 0 || role == "Edit")) {
                    string id = "e" + Elements.Count; Elements[id] = e; Names[id] = name; Bounds[id] = rect;
                    string value = ""; object pattern;
                    if (!password && role == "Edit" && e.TryGetCurrentPattern(ValuePattern.Pattern, out pattern)) value = Short(((ValuePattern)pattern).Current.Value, 240);
                    bool selected = false; if (e.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pattern)) selected = ((SelectionItemPattern)pattern).Current.IsSelected;
                    items.Add(new { id, name, role, bounds = Box(rect), enabled = c.IsEnabled, password, focused = c.HasKeyboardFocus, selected, value, context });
                }
                if (password || entry.Item3 >= 18) continue;
                string nextContext = Tail(context + " " + name);
                var child = TreeWalker.ControlViewWalker.GetFirstChild(e); int siblings = 0;
                while (child != null && siblings++ < 200) { pending.Enqueue(Tuple.Create(child, nextContext, entry.Item3 + 1)); child = TreeWalker.ControlViewWalker.GetNextSibling(child); }
            } catch (ElementNotAvailableException) {} catch (InvalidOperationException) {}
        }
        POINT pointer; GetCursorPos(out pointer); string hover = "";
        if (accessible && Area.Contains(pointer.X, pointer.Y) && GetAncestor(WindowFromPoint(pointer), 2) == Target) {
            try { var c = AutomationElement.FromPoint(new System.Windows.Point(pointer.X, pointer.Y)).Current; if (!c.IsPassword) hover = Short(c.Name); } catch {}
        }
        string image = null; int imageWidth = 0, imageHeight = 0;
        if (request.ContainsKey("image") && request["image"] is bool && (bool)request["image"]) {
            if (Area.Width > 16000 || Area.Height > 16000 || (long)Area.Width * Area.Height > 50000000) throw new Exception("Resize that window before asking KAI to see it.");
            // Visible pixels only. Protected video/secure desktops remain protected.
            double scale = Math.Min(1, Math.Min(1280.0 / Area.Width, 900.0 / Area.Height));
            imageWidth = Math.Max(1, (int)(Area.Width * scale)); imageHeight = Math.Max(1, (int)(Area.Height * scale));
            using (var full = new Bitmap(Area.Width, Area.Height)) using (var g = Graphics.FromImage(full)) {
                g.CopyFromScreen(Area.Location, Point.Empty, Area.Size);
                using (var small = new Bitmap(imageWidth, imageHeight)) using (var draw = Graphics.FromImage(small)) using (var output = new MemoryStream()) {
                    draw.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBilinear; draw.DrawImage(full, 0, 0, imageWidth, imageHeight);
                    small.Save(output, ImageFormat.Png); image = "data:image/png;base64," + Convert.ToBase64String(output.ToArray());
                }
            }
        }
        return new { frame = Frame, window = new { id = Target.ToInt64().ToString(), title = Short(Title(Target)), app = ProcessName(Target) },
            windows = windows.Take(16).Select(w => new { id = w.ToInt64().ToString(), title = Short(Title(w)), app = ProcessName(w) }).ToArray(),
            elements = items, hover, image, imageWidth, imageHeight, bounds = new { x = Area.X, y = Area.Y, width = Area.Width, height = Area.Height }, coordinates = "0..1000 relative to the visible window", truncated = pending.Count > 0 };
    }
    static void FocusTarget() {
        var foreground = GetForegroundWindow();
        if (foreground != Target && !Own(foreground)) throw new Exception("The active window changed. Look again before acting.");
        if (Own(Target) || Blocked(Target) || !IsWindowVisible(Target)) throw new Exception("KAI cannot control this window.");
        if (VisibleArea(Target) != Area) throw new Exception("The window moved. Look again before acting.");
        if (foreground != Target) {
            SetForegroundWindow(Target);
            if (GetForegroundWindow() != Target) { try { AutomationElement.FromHandle(Target).SetFocus(); } catch {} }
            System.Threading.Thread.Sleep(60);
        }
        if (GetForegroundWindow() != Target) throw new Exception("Click the target window to bring it forward, then ask KAI again.");
    }
    static AutomationElement Element(string id) {
        AutomationElement e;
        if (!Elements.TryGetValue(id, out e)) throw new Exception("That control was not in the latest view.");
        var c = e.Current;
        if (c.IsPassword) throw new Exception("Enter passwords yourself. KAI does not type into password fields.");
        if (!c.IsEnabled || c.IsOffscreen || Short(c.Name) != Names[id] || c.BoundingRectangle != Bounds[id]) throw new Exception("That control changed. Look again before acting.");
        return e;
    }
    static INPUT Key(ushort vk, bool up, ushort scan = 0) { return new INPUT { type = 1, data = new UNION { key = new KEYBDINPUT { vk = vk, scan = scan, flags = (uint)((up ? 2 : 0) | (scan != 0 ? 4 : 0)) } } }; }
    static INPUT Mouse(int x, int y, uint flags, uint data = 0) {
        var desktop = System.Windows.Forms.SystemInformation.VirtualScreen;
        return new INPUT { type = 0, data = new UNION { mouse = new MOUSEINPUT { dx = (int)((x - desktop.X) * 65535.0 / Math.Max(1, desktop.Width - 1)), dy = (int)((y - desktop.Y) * 65535.0 / Math.Max(1, desktop.Height - 1)), dwFlags = flags | 0xc000, mouseData = data } } };
    }
    static void Input(params INPUT[] input) { if (SendInput((uint)input.Length, input, Marshal.SizeOf(typeof(INPUT))) != input.Length) throw new Exception("Windows blocked input. Elevated and secure windows require you to act manually."); }
    static POINT PointFor(Dictionary<string, object> r, string xName = "x", string yName = "y") {
        int x = Number(r, xName, -1), y = Number(r, yName, -1); if (x < 0 || x > 1000 || y < 0 || y > 1000) throw new Exception("Coordinates must be between 0 and 1000.");
        var p = new POINT { X = Area.X + (int)(x * (Area.Width - 1) / 1000.0), Y = Area.Y + (int)(y * (Area.Height - 1) / 1000.0) };
        if (GetAncestor(WindowFromPoint(p), 2) != Target) throw new Exception("Another window covers that point. Move it aside and look again.");
        return p;
    }
    static object Act(Dictionary<string, object> r) {
        if (Frame.Length == 0 || Text(r, "frame") != Frame) throw new Exception("Look at the window again before acting.");
        FocusTarget(); string kind = Text(r, "action"), id = Text(r, "element");
        if (kind == "click") {
            var e = Element(id); object pattern;
            Frame = "";
            if (e.TryGetCurrentPattern(InvokePattern.Pattern, out pattern)) ((InvokePattern)pattern).Invoke();
            else if (e.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pattern)) ((SelectionItemPattern)pattern).Select();
            else { System.Windows.Point p; if (!e.TryGetClickablePoint(out p)) throw new Exception("This control has no clickable point. Use a reviewed visual click."); var point = new POINT { X = (int)p.X, Y = (int)p.Y }; if (GetAncestor(WindowFromPoint(point), 2) != Target) throw new Exception("Another window covers this control."); Input(Mouse(point.X, point.Y, 1), Mouse(point.X, point.Y, 2), Mouse(point.X, point.Y, 4)); }
        } else if (kind == "type") {
            var e = Element(id); string text = Text(r, "text"); if (text.Length < 1 || text.Length > 500 || text.Any(c => Char.IsControl(c))) throw new Exception("Type at most 500 plain-text characters at a time.");
            var role = e.Current.ControlType; if (role != ControlType.Edit && role != ControlType.Document) throw new Exception("Choose a text field before typing.");
            e.SetFocus(); if (AutomationElement.FocusedElement.Current.IsPassword) throw new Exception("Enter passwords yourself."); Frame = ""; object pattern;
            if (e.TryGetCurrentPattern(ValuePattern.Pattern, out pattern) && !((ValuePattern)pattern).Current.IsReadOnly) ((ValuePattern)pattern).SetValue(text);
            else Input(text.SelectMany(c => new [] { Key(0, false, c), Key(0, true, c) }).ToArray());
        } else if (kind == "key") {
            var map = new Dictionary<string, ushort[]> { {"ENTER",new ushort[]{13}}, {"TAB",new ushort[]{9}}, {"SHIFT+TAB",new ushort[]{16,9}}, {"ESCAPE",new ushort[]{27}}, {"SPACE",new ushort[]{32}}, {"UP",new ushort[]{38}}, {"DOWN",new ushort[]{40}}, {"LEFT",new ushort[]{37}}, {"RIGHT",new ushort[]{39}}, {"PAGEUP",new ushort[]{33}}, {"PAGEDOWN",new ushort[]{34}}, {"HOME",new ushort[]{36}}, {"END",new ushort[]{35}}, {"CTRL+L",new ushort[]{17,76}}, {"CTRL+A",new ushort[]{17,65}}, {"ALT+LEFT",new ushort[]{18,37}}, {"ALT+RIGHT",new ushort[]{18,39}}, {"ALT+F4",new ushort[]{18,115}} };
            ushort[] keys; if (!map.TryGetValue(Text(r, "key"), out keys)) throw new Exception("That key combination is not supported.");
            if (AutomationElement.FocusedElement.Current.IsPassword) throw new Exception("Finish signing in yourself before KAI continues.");
            if (Text(r, "focus").Length > 0 && !Element(Text(r, "focus")).Current.HasKeyboardFocus) throw new Exception("The focused control changed. Look again before pressing a key.");
            Frame = ""; Input(keys.Select(k => Key(k, false)).Concat(keys.Reverse().Select(k => Key(k, true))).ToArray());
        } else if (kind == "point" || kind == "drag") {
            var p = PointFor(r); Frame = "";
            if (kind == "point") Input(Mouse(p.X, p.Y, 1), Mouse(p.X, p.Y, 2), Mouse(p.X, p.Y, 4));
            else { var end = PointFor(r, "toX", "toY"); var inputs = new List<INPUT> { Mouse(p.X,p.Y,1), Mouse(p.X,p.Y,2) }; for (int i=1;i<=12;i++) inputs.Add(Mouse(p.X+(end.X-p.X)*i/12,p.Y+(end.Y-p.Y)*i/12,1)); inputs.Add(Mouse(end.X,end.Y,4)); Input(inputs.ToArray()); }
        } else if (kind == "scroll") {
            int amount = Math.Max(1, Math.Min(5, Number(r, "amount", 2))); string direction = Text(r, "direction"); if (direction != "up" && direction != "down") throw new Exception("Scroll up or down.");
            var point = new POINT { X = Area.X + Area.Width / 2, Y = Area.Y + Area.Height / 2 };
            if (GetAncestor(WindowFromPoint(point), 2) != Target) throw new Exception("Move KAI away from the middle of the target window, then try again.");
            Frame = ""; Input(Mouse(point.X,point.Y,1), Mouse(point.X,point.Y,0x800,unchecked((uint)(120 * amount * (direction == "up" ? 1 : -1)))));
        } else throw new Exception("Unknown desktop action.");
        return new { ok = true, action = kind, note = "Input completed. Inspect the updated window to verify the result." };
    }
    [MTAThread] static void Main() {
        SetProcessDPIAware(); Console.InputEncoding = new UTF8Encoding(false); Console.OutputEncoding = new UTF8Encoding(false);
        string line;
        while ((line = Console.ReadLine()) != null) {
            object id = null;
            try {
                if (line.Length > 20000) throw new Exception("Desktop request too large."); var r = Json.Deserialize<Dictionary<string, object>>(line); id = r["id"]; IgnorePid = Number(r, "ignorePid");
                string op = Text(r, "op"); object result;
                if (op == "look") result = Look(r);
                else if (op == "act") result = Act(r);
                else if (op == "focus") {
                    var w = Windows().FirstOrDefault(x => x.ToInt64().ToString() == Text(r,"window")); if (w == IntPtr.Zero) throw new Exception("That window is unavailable.");
                    if (IsIconic(w)) ShowWindow(w,9); SetForegroundWindow(w);
                    if (GetForegroundWindow() != w) { try { AutomationElement.FromHandle(w).SetFocus(); } catch {} }
                    Frame=""; result = new { ok = GetForegroundWindow() == w };
                }
                else throw new Exception("Unknown desktop request.");
                Console.WriteLine(Json.Serialize(new { id, result }));
            } catch (Exception error) { Console.WriteLine(Json.Serialize(new { id, error = Short(error.Message, 350) })); }
        }
    }
}
