package app.khafif.share;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Bundle;
import android.util.DisplayMetrics;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONObject;
import org.webrtc.*;

import java.util.ArrayDeque;
import java.util.Collections;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

// Debug build: self-diagnosing screen-share sender. Every step logs visibly;
// no exception is swallowed silently. Shares this phone's screen to a friend
// who answers in the khafif web app (its call UI shows the video track).
public class MainActivity extends Activity {
  static MainActivity inst;
  TextView logView; ScrollView scroller;
  EditText userIn, passIn, friendIn;
  WebSocket ws;
  PeerConnectionFactory factory;
  PeerConnection pc;
  EglBase egl;
  VideoCapturer capturer;
  String me, friend;
  boolean loggedIn = false;
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
    userIn = field("اسم المستخدم"); passIn = field("الباسورد"); friendIn = field("اسم الصاحب");
    root.addView(userIn); root.addView(passIn); root.addView(friendIn);
    Button share = new Button(this);
    share.setText("شارك الشاشة");
    share.setOnClickListener(v -> startFlow());
    root.addView(share);
    Button stop = new Button(this);
    stop.setText("إنهاء المشاركة");
    stop.setOnClickListener(v -> cleanup("اتقفلت بإيدك"));
    root.addView(stop);
    scroller = new ScrollView(this);
    logView = new TextView(this);
    logView.setTextSize(12);
    scroller.addView(logView);
    root.addView(scroller, new LinearLayout.LayoutParams(-1, 0, 1));
    setContentView(root);
    log("جاهز. اكتب بياناتك واضغط شارك الشاشة");
  }

  EditText field(String hint) {
    EditText e = new EditText(this);
    e.setHint(hint);
    return e;
  }

  void startFlow() {
    me = userIn.getText().toString().trim();
    friend = friendIn.getText().toString().trim();
    if (me.isEmpty() || passIn.getText().toString().isEmpty() || friend.isEmpty()) { log("اكتب اسم المستخدم والباسورد واسم الصاحب الأول"); return; }
    if (ws != null) { log("فيه اتصال شغال بالفعل. اضغط إنهاء المشاركة الأول لو عايز تبدأ من جديد"); return; }
    log("بيتصل بالسيرفر...");
    connectWs(passIn.getText().toString());
  }

  void connectWs(String pass) {
    OkHttpClient client = new OkHttpClient.Builder().pingInterval(20, TimeUnit.SECONDS).build();
    Request req = new Request.Builder().url(WS_URL).build();
    ws = client.newWebSocket(req, new WebSocketListener() {
      @Override public void onOpen(WebSocket w, okhttp3.Response r) {
        log("اتصل. بيسجل دخول...");
        try { w.send(new JSONObject().put("t", "login").put("username", me).put("password", pass).toString()); } catch (Throwable t) { log("خطأ إرسال الدخول: " + t); }
      }
      @Override public void onMessage(WebSocket w, String text) { MainActivity.this.onWs(text); }
      @Override public void onMessage(WebSocket w, ByteString b) {}
      @Override public void onFailure(WebSocket w, Throwable t, okhttp3.Response r) { log("فشل الاتصال: " + t); if (ws == w) ws = null; }
      @Override public void onClosed(WebSocket w, int c, String reason) { log("الاتصال اتقفل: " + reason); if (ws == w) ws = null; }
    });
  }

  void onWs(String text) {
    try {
      JSONObject m = new JSONObject(text);
      String t = m.optString("t");
      if (t.equals("logged_in")) { loggedIn = true; log("دخلنا. بيطلب إذن تسجيل الشاشة..."); runOnUiThread(this::askProjection); }
      else if (t.equals("error")) {
        log("خطأ من السيرفر: " + m.optString("text"));
        if (!loggedIn && ws != null) { try { ws.close(1000, "login-error"); } catch (Throwable t2) {} ws = null; }
      }
      else if (t.equals("signal")) { onSignal(m.getJSONObject("data")); }
    } catch (Throwable e) { log("خطأ قراءة رسالة: " + e); }
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
    if (res != RESULT_OK || data == null) { log("الإذن اترفض"); return; }
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
  void cleanup(String why) {
    log("قفل: " + why);
    ShareService.onForeground = null; ShareService.onFailed = null;
    try { if (sharing) sig(new JSONObject().put("call", "end")); } catch (Throwable t) {}
    sharing = false;
    try { if (capturer != null) { capturer.stopCapture(); capturer.dispose(); capturer = null; } } catch (Throwable t) { log("خطأ وقف الالتقاط: " + t); }
    try { if (pc != null) { pc.close(); pc = null; } } catch (Throwable t) { log("خطأ قفل الاتصال: " + t); }
    pendingCand.clear();
    loggedIn = false;
    try { if (ws != null) { ws.close(1000, "cleanup"); ws = null; } } catch (Throwable t) {}
    try { stopService(new Intent(this, ShareService.class)); } catch (Throwable t) {}
  }

  @Override protected void onDestroy() {
    if (sharing) cleanup("التطبيق اتقفل");
    super.onDestroy();
  }

  void addCand(String packed) {
    try {
      JSONObject c = new JSONObject(packed);
      pc.addIceCandidate(new IceCandidate(c.getString("sdpMid"), c.getInt("sdpMLineIndex"), c.getString("candidate")));
    } catch (Throwable t) { log("خطأ مرشح: " + t); }
  }

  void sig(JSONObject data) {
    try {
      if (ws != null) ws.send(new JSONObject().put("t", "signal").put("to", friend).put("data", data).toString());
    } catch (Throwable t) { log("خطأ إرسال إشارة: " + t); }
  }

  class PcObserver implements PeerConnection.Observer {
    @Override public void onIceCandidate(IceCandidate c) {
      try {
        sig(new JSONObject().put("candidate", new JSONObject()
          .put("sdpMid", c.sdpMid).put("sdpMLineIndex", c.sdpMLineIndex).put("candidate", c.sdp)));
      } catch (Throwable t) { log("خطأ إرسال مرشح: " + t); }
    }
    @Override public void onConnectionChange(PeerConnection.PeerConnectionState s) { log("حالة الاتصال: " + s); }
    @Override public void onIceConnectionChange(PeerConnection.IceConnectionState s) { log("حالة ICE: " + s); }
    @Override public void onSignalingChange(PeerConnection.SignalingState s) {}
    @Override public void onIceConnectionReceivingChange(boolean b) {}
    @Override public void onIceGatheringChange(PeerConnection.IceGatheringState s) {}
    @Override public void onIceCandidatesRemoved(IceCandidate[] c) {}
    @Override public void onAddStream(MediaStream s) {}
    @Override public void onRemoveStream(MediaStream s) {}
    @Override public void onDataChannel(DataChannel c) {}
    @Override public void onRenegotiationNeeded() {}
    @Override public void onAddTrack(RtpReceiver r, MediaStream[] s) {}
  }

  static class SdpObs implements SdpObserver {
    final String tag;
    SdpObs(String t) { tag = t; }
    @Override public void onCreateSuccess(SessionDescription s) {}
    @Override public void onSetSuccess() { log(tag + " تم"); }
    @Override public void onCreateFailure(String e) { log(tag + " فشل: " + e); }
    @Override public void onSetFailure(String e) { log(tag + " فشل: " + e); }
  }
}
