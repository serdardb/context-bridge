using System;
using System.IO;
using System.Web.Script.Serialization;

// Acceptance-only target: record exactly what the real launcher delivered.
class WindowsReceiver {
    static int Main(string[] args) {
        var destination = Environment.GetEnvironmentVariable("BRIDGE_FIXTURE_DELIVERED");
        if (String.IsNullOrEmpty(destination)) return 2;
        File.WriteAllText(destination, new JavaScriptSerializer().Serialize(args));
        return 0;
    }
}
