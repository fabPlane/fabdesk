/**
 * The 3D board: a WebView running Google's `<model-viewer>` (orbit, pinch-zoom, two-finger pan)
 * over the daemon's `renders/board.glb`.
 *
 * Why a WebView and not expo-gl + three: model-viewer is a finished glTF viewer with camera
 * controls and lighting in ~300 KB from a CDN, needs no native module beyond the WebView already
 * used for large SVGs, and has no New-Architecture caveats. expo-gl + three would add two native
 * modules and a hand-written orbit control for the same picture. The trade is that the phone needs
 * internet for the script (the model itself never leaves the tailnet).
 *
 * The GLB lives behind `GET /projects/:id/files/*`, which takes the bearer in a header. A WebView
 * cannot attach headers to a `<model-viewer src>` fetch, so the page fetches the bytes itself with
 * the header and hands model-viewer a blob URL. For that fetch to be same-origin (no CORS
 * preflight, and no `Origin: null` for the daemon's origin guard to reject) the document's
 * `baseUrl` is the daemon's own URL. Should the page's fetch fail anyway, it asks the app, which
 * fetches with React Native's `fetch` and injects the model as a data URL — slower, always works.
 */
import { useCoreClient } from "@fabdesk/client-core";
import { useCallback, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { useConnection } from "@/transport/CoreConnection";
import { useTheme } from "@/theme";

const MODEL_VIEWER_CDN =
  "https://ajax.googleapis.com/ajax/libs/model-viewer/4.0.0/model-viewer.min.js";

type PageMessage =
  | { type: "loaded" }
  | { type: "error"; message: string }
  | { type: "fetch-failed"; message: string }
  | { type: "cdn-failed" };

function page(fileUrl: string, authorization: string, background: string): string {
  // JSON.stringify makes the values safe to drop into a script; the header value is the same
  // credential expo-image already carries for the PNG renders.
  const url = JSON.stringify(fileUrl);
  const auth = JSON.stringify(authorization);
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<script type="module" src="${MODEL_VIEWER_CDN}" onerror="window.__cdnFailed()"></script>
<style>
html,body{margin:0;height:100%;background:${background};overflow:hidden}
model-viewer{width:100%;height:100%;--poster-color:transparent;--progress-bar-color:#f97316}
</style></head><body>
<model-viewer id="mv" camera-controls touch-action="none" interaction-prompt="none" shadow-intensity="0.6" exposure="1.1" environment-image="neutral"></model-viewer>
<script>
var post=function(m){window.ReactNativeWebView&&window.ReactNativeWebView.postMessage(JSON.stringify(m))};
window.__cdnFailed=function(){post({type:"cdn-failed"})};
var mv=document.getElementById("mv");
mv.addEventListener("load",function(){post({type:"loaded"})});
mv.addEventListener("error",function(e){post({type:"error",message:(e&&e.detail&&e.detail.sourceError&&e.detail.sourceError.message)||"could not load the model"})});
window.__setModel=function(u){mv.src=u};
window.__reset=function(){mv.cameraOrbit="auto auto auto";mv.cameraTarget="auto auto auto";mv.fieldOfView="auto";mv.jumpCameraToGoal()};
(async function(){
  try{
    var res=await fetch(${url},{headers:{Authorization:${auth}}});
    if(!res.ok)throw new Error("HTTP "+res.status);
    mv.src=URL.createObjectURL(await res.blob());
  }catch(e){post({type:"fetch-failed",message:String(e&&e.message||e)})}
})();
</script></body></html>`;
}

/** Bytes → `data:` URL through FileReader, the one base64 path React Native's runtime has built in. */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
}

export type GlbViewerHandle = { reset: () => void };

export function GlbViewer({
  projectId,
  path,
  onHandle,
}: {
  projectId: string;
  path: string;
  /** Called once with the imperative handle so the screen can put a Reset button in its header. */
  onHandle?: ((h: GlbViewerHandle) => void) | undefined;
}) {
  const t = useTheme();
  const client = useCoreClient();
  const { baseUrl, authHeaders } = useConnection();
  const web = useRef<WebView>(null);
  const [status, setStatus] = useState<string | null>("Loading model…");
  const [fallback, setFallback] = useState(false);
  const background = t.dark ? "#14161a" : "#f1f0e9";

  const fileUrl = client.fileUrl(projectId, path);
  const html = useMemo(
    () =>
      page(fileUrl, authHeaders["Authorization"] ?? authHeaders["authorization"] ?? "", background),
    [fileUrl, authHeaders, background],
  );

  const handle = useMemo<GlbViewerHandle>(
    () => ({
      reset: () => web.current?.injectJavaScript("window.__reset&&window.__reset();true;"),
    }),
    [],
  );
  const onLoadEnd = useCallback(() => onHandle?.(handle), [onHandle, handle]);

  const onMessage = (e: WebViewMessageEvent) => {
    let msg: PageMessage;
    try {
      msg = JSON.parse(e.nativeEvent.data) as PageMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case "loaded":
        setStatus(null);
        break;
      case "cdn-failed":
        setStatus(
          "Could not load the viewer script. The phone needs internet access for the 3D view.",
        );
        break;
      case "error":
        setStatus(`The model could not be shown: ${msg.message}`);
        break;
      case "fetch-failed":
        // The page's own fetch was refused (an origin the daemon would not allow, or a platform
        // that does not grant `baseUrl` its origin); fetch here instead and hand the bytes over.
        if (fallback) {
          setStatus(`The model could not be fetched: ${msg.message}`);
          return;
        }
        setFallback(true);
        setStatus("Loading model (via the app)…");
        void fetch(fileUrl, { headers: authHeaders })
          .then(async (r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return blobToDataUrl(await r.blob());
          })
          .then((dataUrl) =>
            web.current?.injectJavaScript(`window.__setModel(${JSON.stringify(dataUrl)});true;`),
          )
          .catch((err: unknown) =>
            setStatus(
              `The model could not be fetched: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
        break;
    }
  };

  if (!baseUrl) return null;
  return (
    <View style={{ flex: 1, backgroundColor: background }}>
      <WebView
        ref={web}
        originWhitelist={["*"]}
        source={{ html, baseUrl: `${baseUrl}/` }}
        onMessage={onMessage}
        onLoadEnd={onLoadEnd}
        style={{ flex: 1, backgroundColor: background }}
        javaScriptEnabled
        domStorageEnabled
        allowsInlineMediaPlayback
        mixedContentMode="always"
        scrollEnabled={false}
        bounces={false}
        setBuiltInZoomControls={false}
      />
      {status ? (
        <Text
          pointerEvents="none"
          style={{
            position: "absolute",
            top: 12,
            left: 16,
            right: 16,
            textAlign: "center",
            color: t.muted,
            fontSize: 12,
          }}
        >
          {status}
        </Text>
      ) : null}
    </View>
  );
}
