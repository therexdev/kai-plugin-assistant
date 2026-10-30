// Local, stdin/stdout-only speech helper. No network, SSML, shell commands,
// registry changes, voice installation, or microphone access.
using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using System.Text;
using System.Web.Script.Serialization;
using DesktopSynth = System.Speech.Synthesis.SpeechSynthesizer;
using WindowsSynth = Windows.Media.SpeechSynthesis.SpeechSynthesizer;
class KaiWindowsVoice {
    class Voice {
        public string id, name, lang, engine;
        public object handle;
        public object Info() { return new { id, name, lang, engine }; }
    }
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 16 * 1024 * 1024 };
    static readonly List<Voice> Voices = new List<Voice>();
    static WindowsSynth windows;
    static DesktopSynth desktop;
    static void LoadVoices() {
        Voices.Clear();
        try {
            if (windows == null) windows = new WindowsSynth();
            foreach (var v in WindowsSynth.AllVoices) Voices.Add(new Voice {
                id = "onecore:" + v.Id, name = v.DisplayName, lang = v.Language, engine = "Windows", handle = v
            });
        } catch { /* Older/limited Windows installations may only have SAPI. */ }
        try {
            if (desktop == null) desktop = new DesktopSynth();
            foreach (var installed in desktop.GetInstalledVoices()) {
                var v = installed.VoiceInfo;
                var name = v.Name.Replace(" Desktop", "");
                if (installed.Enabled && !Voices.Any(x => x.name.Replace(" Desktop", "") == name && x.lang == v.Culture.Name))
                    Voices.Add(new Voice { id = "sapi:" + v.Id, name = v.Name, lang = v.Culture.Name, engine = "Desktop", handle = v.Name });
            }
        } catch { /* OneCore can work when no desktop SAPI voices exist. */ }
    }
    static byte[] Speak(string text, Voice voice) {
        using (var output = new MemoryStream()) {
            if (voice.engine == "Windows") {
                windows.Voice = (Windows.Media.SpeechSynthesis.VoiceInformation)voice.handle;
                using (var result = windows.SynthesizeTextToStreamAsync(text).AsTask().GetAwaiter().GetResult())
                using (var input = result.AsStreamForRead()) input.CopyTo(output);
            } else {
                desktop.SelectVoice((string)voice.handle);
                desktop.Rate = 0;
                desktop.SetOutputToWaveStream(output);
                try { desktop.Speak(text); } finally { desktop.SetOutputToNull(); }
            }
            return output.ToArray();
        }
    }
    static void Main() {
        Console.InputEncoding = new UTF8Encoding(false); Console.OutputEncoding = new UTF8Encoding(false);
        string line;
        while ((line = Console.ReadLine()) != null) {
            object id = null;
            try {
                if (line.Length > 16000) throw new Exception("Voice request is too large.");
                var request = Json.Deserialize<Dictionary<string, object>>(line); id = request["id"];
                string op = (string)request["op"];
                if (op == "status") {
                    LoadVoices(); Console.WriteLine(Json.Serialize(new { id, voices = Voices.Select(v => v.Info()).ToArray() }));
                } else if (op == "speak") {
                    string text = (string)request["text"], choice = (string)request["voice"];
                    if (String.IsNullOrWhiteSpace(text) || text.Length > 1200) throw new Exception("Speak one sentence at a time.");
                    var voice = Voices.Find(v => v.id == choice);
                    if (voice == null) throw new Exception("That Windows voice is no longer installed. Refresh voices.");
                    byte[] wav = Speak(text, voice);
                    if (wav.Length > 8 * 1024 * 1024) throw new Exception("The voice response is too large.");
                    Console.WriteLine(Json.Serialize(new { id, wav = Convert.ToBase64String(wav) }));
                } else throw new Exception("Unknown voice request.");
            } catch (Exception error) {
                Console.WriteLine(Json.Serialize(new { id, error = error.Message }));
            }
        }
        if (desktop != null) desktop.Dispose(); if (windows != null) windows.Dispose();
    }
}
