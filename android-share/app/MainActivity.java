package app.khafif.share;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.util.DisplayMetrics;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import org.webrtc.*;

import java.util.ArrayDeque;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

// Debug build: self-diagnosing screen-share sender. Every step logs visibly;
// no exception is swallowed silently. Auth (login/register) is explicit and
// independent of capture: the user signs in first, picks a friend, and only
// then taps share, which asks the Android screen-recording consent.
public class MainActivity extends Activity {
  static MainActivity inst;
  TextView logView, statusView; ScrollView scroller;
  EditText userIn, passIn, friendIn;
  WebSocket ws;
  PeerConnectionFactory factory;
  PeerConnection pc;
  EglBase egl;
  VideoCapturer capturer;
  String me, friend;
  boolean loggedIn = false;
  volatile boolean stateReceived = false;
  String pendingAuth = null; // "login" or "register" across a ws reconnect
  final Map<String, Boolean> friends = Collections.synchronizedMap(new HashMap<>()); // name -> online; written on ws thread, read on UI thread
  final ArrayDeque<String> pendingCand = new ArrayDeque<>();
  static final String WS_URL = "wss://khafif-signal.onrender.com/ws";

  static void log(final String s) {
    final MainActivity a = inst;
    if (a == null) return;
    a.runOnUiThread(() -> {
      a.logView.append(s + "\n");
      a.scroller.post(() -> a.scroller.fullScroll(View.FOCUS_DOWN));
    });
  }

  void setStatus(final String s) {
    runOnUiThread(() -> statusView.setText("الحالة: " + s));
  }

  @Override protected void onCreate(Bundle b) {
    super.onCreate(b);
    inst = this;
    Thread.setDefaultUncaughtExceptionHandler((t, e) -> {
      log("انهيار غير متوقع: " + e);
      android.util.Log.e("khafif", "crash", e);
    });
    LinearLayout root = new LinearLayout(this);
    root.setOrientation(LinearLayout.VERTICAL);
    int pad = (int) (12 * getResources().getDisplayMetrics().density);
    root.setPadding(pad, pad, pad, pad);

    statusView = new TextView(this);
    statusView.setTextSize(15);
    statusView.setText("الحالة: مش مسجل");
    root.addView(statusView);

    userIn = field("اسم المستخدم", false);
    passIn = field("الباسورد", true);
    friendIn = field("اسم الصاحب", false);
    root.addView(userIn); root.addView(passIn); root.addView(friendIn);

    LinearLayout authRow = new LinearLayout(this);
    Button login = new Button(this); login.setText("تسجيل دخول");
    login.setOnClickListener(v -> auth("login"));
    Button register = new Button(this); register.setText("إنشاء حساب");
    register.setOnClickListener(v -> auth("register"));
    authRow.addView(login, new LinearLayout.LayoutParams(0, -2, 1));
    authRow.addView(register, new LinearLayout.LayoutParams(0, -2, 1));
    root.addView(authRow);

    LinearLayout shareRow = new LinearLayout(this);
    Button share = new Button(this); share.setText("شارك الشاشة");
    share.setOnClickListener(v -> startShare());
    Button stop = new Button(this); stop.setText("إنهاء المشاركة");
    stop.setOnClickListener(v -> cleanup("اتقفلت بإيدك"));
    shareRow.addView(share, new LinearLayout.LayoutParams(0, -2, 1));
    shareRow.addView(stop, new LinearLayout.LayoutParams(0, -2, 1));
    root.addView(shareRow);

    scroller = new ScrollView(this);
    logView = new TextView(this);
    logView.setTextSize(12);
    scroller.addView(logView);
    root.addView(scroller, new LinearLayout.LayoutParams(-1, 0, 1));
    setContentView(root);
    log("جاهز. سجّل دخولك أو اعمل حساب الأول");
    connectWs();
  }

  EditText field(String hint, boolean password) {
    EditText e = new EditText(this);
    e.setHint(hint);
    if (password) e.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
    return e;
  }

  // Explicit auth, independent of capture. Keeps a single connection; if the
  // socket dropped, reconnects and performs the pending auth on open.
  void auth(String kind) {
    me = userIn.getText().toString().trim();
    String pass = passIn.getText().toString();
    if (me.isEmpty() || pass.isEmpty()) { log("اكتب اسم المستخدم والباسورد الأول"); return; }
    if (loggedIn) { log("إنت مسجل دخول بالفعل كـ " + me); return; }
    pendingAuth = kind;
    if (ws == null) { log("بيتصل بالسيرفر..."); connectWs(); return; }
    sendAuth(kind, pass);
  }

  void sendAuth(String kind, String pass) {
    try {
      ws.send(new JSONObject().put("t", kind).put("username", me).put("password", pass).toString());
      log(kind.equals("register") ? "بينشئ الحساب..." : "بيسجل دخول...");
    } catch (Throwable t) { log("خطأ إرسال الدخول: " + t); }
  }

  void connectWs() {
    OkHttpClient client = new OkHttpClient.Builder().pingInterval(20, TimeUnit.SECONDS).build();
    Request req = new Request.Builder().url(WS_URL).build();
    ws = client.newWebSocket(req, new WebSocketListener() {
      @Override public void onOpen(WebSocket w, okhttp3.Response r) {
        log("اتصل بالسيرفر");
        String kind = pendingAuth;
        if (kind != null) { pendingAuth = null; sendAuth(kind, passIn.getText().toString()); }
      }
      @Override public void onMessage(WebSocket w, String text) { MainActivity.this.onWs(text); }
      @Override public void onMessage(WebSocket w, ByteString b) {}
      @Override public void onFailure(WebSocket w, Throwable t, okhttp3.Response r) {
        log("فشل الاتصال: " + t + ". السيرفر ممكن بيصحى، جرّب تاني بعد شوية");
        if (ws == w) ws = null;
      }
      @Override public void onClosed(WebSocket w, int c, String reason) {
        log("الاتصال اتقفل: " + reason);
        if (ws == w) ws = null;
        if (loggedIn) { loggedIn = false; setStatus("مش مسجل"); }
      }
    });
  }

  void onWs(String text) {
    try {
      JSONObject m = new JSONObject(text);
      String t = m.optString("t");
      if (t.equals("logged_in") || t.equals("registered")) {
        loggedIn = true;
        setStatus("مسجل كـ " + me);
        log(t.equals("registered") ? "الحساب اتعمل ودخلنا" : "دخلنا تمام");
      } else if (t.equals("state")) {
        stateReceived = true;
        friends.clear();
        JSONArray fs = m.optJSONArray("friends");
        if (fs != null) for (int i = 0; i < fs.length(); i++) {
          JSONObject f = fs.getJSONObject(i);
          friends.put(f.getString("name"), f.optBoolean("online"));
        }
        StringBuilder sb = new StringBuilder("أصحابك: ");
        if (friends.isEmpty()) sb.append("لسه مفيش. ضيف صاحبك من صفحة الشات الأول");
        else synchronized (friends) { for (Map.Entry<String, Boolean> e : friends.entrySet()) sb.append(e.getKey()).append(e.getValue() ? " (متصل)" : " (مش متصل)").append("، "); }
        log(sb.toString());
      } else if (t.equals("presence")) {
        friends.put(m.optString("user"), m.optBoolean("online"));
        log(m.optString("user") + (m.optBoolean("online") ? " بقى متصل" : " قفل الشات"));
      } else if (t.equals("error")) {
        String err = m.optString("text");
        log("خطأ من السيرفر: " + err);
        if (m.optString("code").equals("online_elsewhere")) log("اقفل صفحة الشات في المتصفح الأول، الحساب مفتوح هناك");
      } else if (t.equals("signal")) {
        onSignal(m.getJSONObject("data"));
      }
    } catch (Throwable e) { log("خطأ قراءة رسالة: " + e); }
  }

  // Share tap: only meaningful after login. Preflights the friend from the
  // server's own state/presence before any consent prompt appears.
  void startShare() {
    if (!loggedIn) { log("سجّل دخول الأول بزرار تسجيل دخول"); return; }
    if (sharing || pc != null) { log("فيه مشاركة شغالة بالفعل. اضغط إنهاء المشاركة الأول"); return; }
    friend = friendIn.getText().toString().trim();
    if (friend.isEmpty()) { log("اكتب اسم الصاحب الأول"); return; }
    if (!stateReceived) { log("لسه بيجيب قائمة الأصحاب من السيرفر، جرّب بعد ثانية"); return; }
    if (!friends.containsKey(friend)) { log(friend + " مش من أصحابك لسه. ضيفه وخلّيه يقبل من صفحة الشات الأول"); return; }
    if (!Boolean.TRUE.equals(friends.get(friend))) { log(friend + " مش فاتح الشات دلوقتي. خلّيه يفتحه الأول وبعدين جرّب"); return; }
    log("بيطلب إذن تسجيل الشاشة...");
    askProjection();
  }

  void askProjection() {
    try {
      MediaProjectionManager mpm = (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);
      startActivityForResult(mpm.createScreenCaptureIntent(), 7);
    } catch (Throwable t) { log("خطأ طلب الإذن: " + t); }
  }

  @Override protected void onActivityResult(int req, int res, Intent data) {
    super.onActivityResult(req, res, data);
    if (req != 7) return;
    if (res != RESULT_OK || data == null) { log("الإذن اترفض. مفيش حاجة اتسجلت ولا اتبعتت"); return; }
    log("الإذن اتمنح. بيشغل الخدمة...");
    final Intent fd = data;
    ShareService.onForeground = () -> runOnUiThread(() -> startCapture(fd));
    ShareService.onFailed = () -> runOnUiThread(() -> log("خدمة المقدمة فشلت، المشاركة ماتبدأتش"));
    try {
      if (Build.VERSION.SDK_INT >= 26) startForegroundService(new Intent(this, ShareService.class));
      else startService(new Intent(this, ShareService.class));
    } catch (Throwable t) {
      ShareService.onForeground = null; ShareService.onFailed = null;
      log("خطأ تشغيل الخدمة: " + t);
      return;
    }
  }

  void startCapture(Intent projData) {
    try {
      egl = EglBase.create();
      PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(this).createInitializationOptions());
      PeerConnectionFactory.Options opts = new PeerConnectionFactory.Options();
      factory = PeerConnectionFactory.builder()
        .setVideoEncoderFactory(new DefaultVideoEncoderFactory(egl.getEglBaseContext(), true, true))
        .setVideoDecoderFactory(new DefaultVideoDecoderFactory(egl.getEglBaseContext()))
        .setOptions(opts).createPeerConnectionFactory();
      PeerConnection.RTCConfiguration cfg = new PeerConnection.RTCConfiguration(
        java.util.Arrays.asList(
          PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer(),
          PeerConnection.IceServer.builder("stun:stun1.l.google.com:19302").createIceServer()));
      pc = factory.createPeerConnection(cfg, new PcObserver());
      log("WebRTC جاهز. بيبدأ التقاط الشاشة...");
      capturer = new ScreenCapturerAndroid(projData, new MediaProjection.Callback() {
        @Override public void onStop() { cleanup("المشاركة وقفت من النظام"); }
      });
      VideoSource src = factory.createVideoSource(true);
      SurfaceTextureHelper helper = SurfaceTextureHelper.create("cap", egl.getEglBaseContext());
      capturer.initialize(helper, this, src.getCapturerObserver());
      DisplayMetrics dm = getResources().getDisplayMetrics();
      capturer.startCapture(dm.widthPixels, dm.heightPixels, dm.scaledDensity >= 3 ? 12 : 15);
      VideoTrack track = factory.createVideoTrack("screen", src);
      pc.addTrack(track, Collections.singletonList("screen-stream"));
      sharing = true;
      log("الالتقاط شغال. بيعمل عرض اتصال...");
      pc.createOffer(new SdpObs("offer") {
        @Override public void onCreateSuccess(SessionDescription sdp) {
          try {
            pc.setLocalDescription(new SdpObs("setLocal"), sdp);
            sig(new JSONObject().put("description", new JSONObject().put("type", "offer").put("sdp", sdp.description)));
            log("العرض اتبعت لـ " + friend + ". مستني يرد من التطبيق...");
            logView.postDelayed(() -> {
              if (sharing && pc != null && pc.getRemoteDescription() == null) { log("الصاحب ماردش خلال 30 ثانية. اتأكد إنه فاتح الشات وجرّب تاني"); cleanup("مفيش رد من الصاحب"); }
            }, 30000);
          } catch (Throwable t) { log("خطأ إرسال العرض: " + t); }
        }
      }, new MediaConstraints());
    } catch (Throwable t) {
      log("خطأ بدء المشاركة: " + t);
      cleanup("فشل بدء المشاركة"); // no capture -> no service left behind
    }
  }

  void onSignal(JSONObject data) {
    try {
      if (data.has("description")) {
        JSONObject d = data.getJSONObject("description");
        SessionDescription sd = new SessionDescription(SessionDescription.Type.fromCanonicalForm(d.getString("type")), d.getString("sdp"));
        pc.setRemoteDescription(new SdpObs("setRemote") {
          @Override public void onSetSuccess() {
            while (!pendingCand.isEmpty()) addCand(pendingCand.poll());
          }
        }, sd);
        log("الرد وصل من " + friend);
      } else if (data.has("candidate")) {
        JSONObject c = data.getJSONObject("candidate");
        if (pc == null || pc.getRemoteDescription() == null) pendingCand.add(c.toString());
        else addCand(c.toString());
      } else if (data.optString("call").equals("end")) {
        cleanup("الطرف التاني قفل");
      }
    } catch (Throwable t) { log("خطأ إشارة: " + t); }
  }

  boolean sharing = false;
  // Ends capture and the peer connection but keeps the login session, so the
  // user can share again without signing in twice.
  void cleanup(String why) {
    log("قفل المشاركة: " + why);
    ShareService.onForeground = null; ShareService.onFailed = null;
    try { if (sharing) sig(new JSONObject().put("call", "end")); } catch (Throwable t) {}
    sharing = false;
    try { if (capturer != null) { capturer.stopCapture(); capturer.dispose(); capturer = null; } } catch (Throwable t) { log("خطأ وقف الالتقاط: " + t); }
    try { if (pc != null) { pc.close(); pc = null; } } catch (Throwable t) { log("خطأ قفل الاتصال: " + t); }
    pendingCand.clear();
    try { stopService(new Intent(this, ShareService.class)); } catch (Throwable t) {}
  }

  @Override protected void onDestroy() {
    cleanup("التطبيق اتقفل");
    try { if (ws != null) { ws.close(1000, "app-closed"); ws = null; } } catch (Throwable t) {}
    super.onDestroy();
  }

  void sig(JSONObject data) {
    try {
      if (ws != null) ws.send(new JSONObject().put("t", "signal").put("to", friend).put("data", data).toString());
    } catch (Throwable t) { log("خطأ إرسال إشارة: " + t); }
  }

  void addCand(String json) {
    try {
      JSONObject c = new JSONObject(json);
      pc.addIceCandidate(new IceCandidate(c.getString("sdpMid"), c.getInt("sdpMLineIndex"), c.getString("candidate")));
    } catch (Throwable t) { log("خطأ مرشح: " + t); }
  }

  class PcObserver implements PeerConnection.Observer {
    @Override public void onIceCandidate(IceCandidate c) {
      try {
        sig(new JSONObject().put("candidate", new JSONObject()
          .put("sdpMid", c.sdpMid).put("sdpMLineIndex", c.sdpMLineIndex).put("candidate", c.sdp)));
      } catch (Throwable t) { log("خطأ إرسال مرشح: " + t); }
    }
    @Override public void onConnectionChange(PeerConnection.PeerConnectionState s) { log("حالة الاتصال: " + s); }
    @Override public void onSignalingChange(PeerConnection.SignalingState s) {}
    @Override public void onIceConnectionChange(PeerConnection.IceConnectionState s) { log("ICE: " + s); }
    @Override public void onIceConnectionReceivingChange(boolean b) {}
    @Override public void onIceGatheringChange(PeerConnection.IceGatheringState s) {}
    @Override public void onIceCandidatesRemoved(IceCandidate[] cs) {}
    @Override public void onAddStream(MediaStream ms) {}
    @Override public void onRemoveStream(MediaStream ms) {}
    @Override public void onDataChannel(DataChannel dc) {}
    @Override public void onRenegotiationNeeded() {}
    @Override public void onAddTrack(RtpReceiver r, MediaStream[] mss) {}
  }

  static class SdpObs implements SdpObserver {
    final String tag;
    SdpObs(String t) { tag = t; }
    @Override public void onCreateSuccess(SessionDescription sdp) {}
    @Override public void onSetSuccess() {}
    @Override public void onCreateFailure(String s) { log("فشل " + tag + ": " + s); }
    @Override public void onSetFailure(String s) { log("فشل " + tag + ": " + s); }
  }
}
