// Static, loopback-only server using the .NET Framework included with Windows.
// No Python, Node.js, admin URL reservation or external runtime is required.
using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading.Tasks;

namespace HospitalMap
{
    public sealed class LocalMapServer
    {
        private readonly string root;
        private readonly string identity;
        private readonly TcpListener listener;
        private readonly TcpListener ipv6Listener;
        private volatile bool running;
        public bool IsRunning { get { return running; } }

        public LocalMapServer(string directory, int port, string instanceIdentity)
        {
            root = Path.GetFullPath(directory).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            identity = instanceIdentity;
            listener = new TcpListener(IPAddress.Loopback, port);
            listener.Server.ExclusiveAddressUse = true;
            if (Socket.OSSupportsIPv6)
            {
                ipv6Listener = new TcpListener(IPAddress.IPv6Loopback, port);
                ipv6Listener.Server.DualMode = false;
                ipv6Listener.Server.ExclusiveAddressUse = true;
            }
        }
        public void Start()
        {
            try
            {
                listener.Start(128);
                if (ipv6Listener != null) ipv6Listener.Start(128);
            }
            catch { Stop(); throw; }
            running = true;
            Task.Run(() => AcceptLoop(listener));
            if (ipv6Listener != null) Task.Run(() => AcceptLoop(ipv6Listener));
        }
        public void Stop()
        {
            running = false;
            listener.Stop();
            if (ipv6Listener != null) ipv6Listener.Stop();
        }
        private async Task AcceptLoop(TcpListener accepting)
        {
            while (running)
            {
                TcpClient client;
                try { client = await accepting.AcceptTcpClientAsync().ConfigureAwait(false); }
                catch { if (running) running = false; break; }
                Dispatch(client);
            }
        }
        private void Dispatch(TcpClient client)
        {
            Task.Run(() => Handle(client));
        }
        private void Handle(TcpClient client)
        {
            using (client)
            {
                client.ReceiveTimeout = 5000;
                client.SendTimeout = 15000;
                try
                {
                    using (NetworkStream stream = client.GetStream())
                    {
                        byte[] bytes = new byte[32768];
                        int count = 0;
                        string header = null;
                        while (count < bytes.Length)
                        {
                            int read = stream.Read(bytes, count, Math.Min(4096, bytes.Length - count));
                            if (read == 0) return;
                            count += read;
                            header = Encoding.ASCII.GetString(bytes, 0, count);
                            if (header.IndexOf("\r\n\r\n", StringComparison.Ordinal) >= 0) break;
                        }
                        if (header == null || header.IndexOf("\r\n\r\n", StringComparison.Ordinal) < 0)
                        { Text(stream, 431, "Request Header Fields Too Large", "Request headers are too large.", false); return; }
                        string[] first = header.Substring(0, header.IndexOf("\r\n", StringComparison.Ordinal)).Split(' ');
                        if (first.Length != 3 || !first[1].StartsWith("/", StringComparison.Ordinal))
                        { Text(stream, 400, "Bad Request", "Bad request.", false); return; }
                        bool head = first[0] == "HEAD";
                        if (first[0] != "GET" && !head)
                        { Text(stream, 405, "Method Not Allowed", "Only GET and HEAD are supported.", false); return; }
                        string requestPath = first[1].Split('?')[0];
                        if (requestPath == "/.well-known/hospital-map")
                        {
                            byte[] health = Encoding.UTF8.GetBytes("{\"identity\":\"" + identity + "\"}");
                            Headers(stream, 200, "OK", "application/json; charset=utf-8", health.Length);
                            if (!head) stream.Write(health, 0, health.Length);
                            return;
                        }
                        string path;
                        try
                        {
                            string relative = Uri.UnescapeDataString(requestPath).Replace('\\', '/').TrimStart('/');
                            if (relative.IndexOf('\0') >= 0 || relative.IndexOf(':') >= 0) throw new ArgumentException();
                            path = Path.GetFullPath(Path.Combine(root, relative.Replace('/', Path.DirectorySeparatorChar)));
                            if (Directory.Exists(path)) path = Path.Combine(path, "index.html");
                        }
                        catch { Text(stream, 400, "Bad Request", "Invalid path.", head); return; }
                        if (!path.StartsWith(root, StringComparison.OrdinalIgnoreCase))
                        { Text(stream, 403, "Forbidden", "Path is outside this site.", head); return; }
                        if (!File.Exists(path))
                        { Text(stream, 404, "Not Found", "File not found.", head); return; }
                        using (FileStream file = File.OpenRead(path))
                        {
                            Headers(stream, 200, "OK", Mime(path), file.Length);
                            if (!head) file.CopyTo(stream, 65536);
                        }
                    }
                }
                // Closing a browser tab or an idle pre-connection is harmless.
                catch (IOException) { }
                catch (SocketException) { }
                catch (ObjectDisposedException) { }
                catch (Exception error) { Console.Error.WriteLine("Request failed: " + error.GetType().Name); }
            }
        }
        private static void Headers(Stream stream, int code, string reason, string mime, long length)
        {
            string text = "HTTP/1.1 " + code + " " + reason + "\r\nContent-Type: " + mime +
                "\r\nContent-Length: " + length + "\r\nCache-Control: no-cache\r\n" +
                "X-Content-Type-Options: nosniff\r\nReferrer-Policy: strict-origin-when-cross-origin\r\nConnection: close\r\n\r\n";
            byte[] header = Encoding.ASCII.GetBytes(text);
            stream.Write(header, 0, header.Length);
        }
        private static void Text(Stream stream, int code, string reason, string message, bool head)
        {
            byte[] body = Encoding.UTF8.GetBytes(message);
            Headers(stream, code, reason, "text/plain; charset=utf-8", body.Length);
            if (!head) stream.Write(body, 0, body.Length);
        }
        private static string Mime(string path)
        {
            switch (Path.GetExtension(path).ToLowerInvariant())
            {
                case ".html": return "text/html; charset=utf-8";
                case ".js": return "text/javascript; charset=utf-8";
                case ".css": return "text/css; charset=utf-8";
                case ".json": case ".geojson": return "application/json; charset=utf-8";
                case ".svg": return "image/svg+xml";
                case ".png": return "image/png";
                case ".jpg": case ".jpeg": return "image/jpeg";
                case ".ico": return "image/x-icon";
                case ".woff2": return "font/woff2";
                case ".txt": case ".md": return "text/plain; charset=utf-8";
                default: return "application/octet-stream";
            }
        }
    }
}
