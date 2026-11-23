package com.tunebridge.provider.netease;

import com.tunebridge.domain.ProviderId;
import com.tunebridge.provider.ProviderException;
import com.tunebridge.provider.netease.NeteaseWebClient.QrStatus;
import com.tunebridge.service.ConnectionService;
import jakarta.servlet.http.HttpSession;
import java.security.SecureRandom;
import java.util.HexFormat;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

/**
 * 扫码登录的会话侧编排：每个登录请求绑定到当前 HTTP 会话，二维码密钥与登录凭据只留在内存，
 * 会话销毁即失效，绝不入库也不回传前端。
 */
@Service
public class NeteaseQrLoginService {

    private static final Logger log = LoggerFactory.getLogger(NeteaseQrLoginService.class);
    private static final long TTL_MILLIS = 120_000L;
    private static final long MIN_POLL_MILLIS = 900L;
    private static final int MAX_PENDING = 64;
    private static final String QR_TARGET = "https://music.163.com/login?codekey=";

    private final NeteaseWebClient client;
    private final ConnectionService connections;
    private final SecureRandom random = new SecureRandom();
    private final Map<String, Pending> pendings = new ConcurrentHashMap<>();

    public NeteaseQrLoginService(NeteaseWebClient client, ConnectionService connections) {
        this.client = client;
        this.connections = connections;
    }

    public StartView start(HttpSession session) {
        purgeExpired();
        for (Pending pending : pendings.values()) {
            if (pending.sessionId.equals(session.getId()) && System.currentTimeMillis() < pending.expiresAt) {
                return synchronizedView(pending);
            }
        }
        if (pendings.size() >= MAX_PENDING) {
            throw ProviderException.badRequest("登录请求过多，请稍后再试");
        }
        String unikey = client.requestQrKey();
        String target = QR_TARGET + unikey;
        byte[] bytes = new byte[16];
        random.nextBytes(bytes);
        Pending entry = new Pending(HexFormat.of().formatHex(bytes), session.getId(), unikey,
                QrCodeSvg.render(target), System.currentTimeMillis() + TTL_MILLIS);
        pendings.put(entry.loginId, entry);
        return new StartView(entry.loginId, entry.svg, target, TTL_MILLIS / 1000L);
    }

    public PollView poll(HttpSession session, String loginId) {
        Pending entry = loginId == null ? null : pendings.get(loginId);
        if (entry == null || !entry.sessionId.equals(session.getId())) {
            throw ProviderException.badRequest("登录二维码已失效，请重新获取");
        }
        synchronized (entry) {
            if (System.currentTimeMillis() >= entry.expiresAt) {
                pendings.remove(entry.loginId);
                return new PollView("expired", "二维码已过期，请重新获取", "");
            }
            long now = System.currentTimeMillis();
            if (now - entry.lastPollAt < MIN_POLL_MILLIS && entry.lastView != null) {
                return entry.lastView;
            }
            entry.lastPollAt = now;
            PollView view = check(entry, session);
            entry.lastView = view;
            if (!"waiting".equals(view.state()) && !"scanned".equals(view.state())) {
                pendings.remove(entry.loginId);
            }
            return view;
        }
    }

    private PollView check(Pending entry, HttpSession session) {
        QrStatus status = client.pollQr(entry.unikey);
        return switch (status.code()) {
            case 801 -> new PollView("waiting", "等待扫码", "");
            case 802 -> new PollView("scanned", "已扫码，请在手机上确认", "");
            case 800 -> new PollView("expired", "二维码已过期，请重新获取", "");
            case 803 -> connected(entry, session, status.cookie());
            default -> unexpected(status);
        };
    }

    /** 上游给出预期外的状态时，把状态码和原文一起回报，否则用户和服务端都只能看到一句无信息量的「异常」。 */
    private PollView unexpected(QrStatus status) {
        String detail = status.code() == 0 ? "响应里没有登录状态码"
                : "状态码 " + status.code() + (status.message().isBlank() ? "" : "：" + status.message());
        log.warn("Unexpected NetEase QR login state: {}", detail);
        return new PollView("failed", "网易云登录状态异常（" + detail + "），请重新获取二维码", "");
    }

    private PollView connected(Pending entry, HttpSession session, String cookie) {
        try {
            var connection = connections.connect(session, ProviderId.NETEASE_MUSIC, "real",
                    Map.of("cookie", cookie));
            return new PollView("connected", "已连接网易云账号", connection.accountName());
        } catch (ProviderException ex) {
            return new PollView("failed", ex.getMessage(), "");
        }
    }

    private StartView synchronizedView(Pending entry) {
        synchronized (entry) {
            return new StartView(entry.loginId, entry.svg, QR_TARGET + entry.unikey,
                    Math.max(1L, (entry.expiresAt - System.currentTimeMillis()) / 1000L));
        }
    }

    private void purgeExpired() {
        long now = System.currentTimeMillis();
        pendings.entrySet().removeIf(e -> now >= e.getValue().expiresAt);
    }

    private static final class Pending {
        private final String loginId;
        private final String sessionId;
        private final String unikey;
        private final String svg;
        private final long expiresAt;
        private long lastPollAt;
        private PollView lastView;

        private Pending(String loginId, String sessionId, String unikey, String svg, long expiresAt) {
            this.loginId = loginId;
            this.sessionId = sessionId;
            this.unikey = unikey;
            this.svg = svg;
            this.expiresAt = expiresAt;
        }
    }

    public record StartView(String loginId, String svg, String target, long expiresInSeconds) {
    }

    public record PollView(String state, String message, String accountName) {
    }
}
