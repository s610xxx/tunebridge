package com.tunebridge.service;

import com.tunebridge.domain.ProviderConnection;
import com.tunebridge.domain.ProviderId;
import com.tunebridge.provider.MusicProvider;
import com.tunebridge.provider.ProviderException;
import com.tunebridge.provider.ProviderRegistry;
import com.tunebridge.provider.netease.NeteaseLocalAccess;
import jakarta.servlet.http.HttpSession;
import jakarta.servlet.http.HttpSessionBindingEvent;
import jakarta.servlet.http.HttpSessionBindingListener;
import java.util.EnumMap;
import java.util.Map;
import org.springframework.stereotype.Service;

@Service
public class ConnectionService {

    private static final String CONNECTIONS_ATTRIBUTE = "tunebridge.connections.v1";
    private static final String NETEASE_GRANT_ATTRIBUTE = "tunebridge.netease.grant.v1";

    private final ProviderRegistry providerRegistry;
    private final NeteaseLocalAccess neteaseLocalAccess;

    public ConnectionService(ProviderRegistry providerRegistry, NeteaseLocalAccess neteaseLocalAccess) {
        this.providerRegistry = providerRegistry;
        this.neteaseLocalAccess = neteaseLocalAccess;
    }

    public ProviderConnection connect(HttpSession session, ProviderId providerId, String mode,
                                      Map<String, String> credentials) {
        synchronized (session) {
            MusicProvider provider = providerRegistry.get(providerId);
            ProviderConnection connection;
            if (mode == null) {
                throw ProviderException.badRequest("请选择连接方式");
            }
            if ("demo".equalsIgnoreCase(mode)) {
                connection = provider.connectDemo(session.getId());
            } else if ("real".equalsIgnoreCase(mode)) {
                connection = provider.connectReal(credentials == null ? Map.of() : credentials);
            } else {
                throw ProviderException.badRequest("不支持的连接方式：" + mode);
            }
            if (providerId == ProviderId.NETEASE_MUSIC) {
                session.removeAttribute(NETEASE_GRANT_ATTRIBUTE);
                String grant = connection.credential("neteaseGrant");
                if (grant != null) {
                    session.setAttribute(NETEASE_GRANT_ATTRIBUTE, new NeteaseGrant(neteaseLocalAccess, grant));
                }
            }
            connections(session).put(providerId, connection);
            return connection;
        }
    }

    public ProviderConnection get(HttpSession session, ProviderId providerId) {
        return connections(session).get(providerId);
    }

    public ProviderConnection require(HttpSession session, ProviderId providerId) {
        ProviderConnection connection = get(session, providerId);
        if (connection == null) {
            throw ProviderException.notConnected("请先连接" + providerId.label());
        }
        return connection;
    }

    public Map<ProviderId, ProviderConnection> all(HttpSession session) {
        return new EnumMap<>(connections(session));
    }

    public void disconnect(HttpSession session, ProviderId providerId) {
        synchronized (session) {
            connections(session).remove(providerId);
            if (providerId == ProviderId.NETEASE_MUSIC) {
                session.removeAttribute(NETEASE_GRANT_ATTRIBUTE);
            }
        }
    }

    private record NeteaseGrant(NeteaseLocalAccess access, String grant) implements HttpSessionBindingListener {
        @Override
        public void valueUnbound(HttpSessionBindingEvent event) {
            access.revoke(grant);
        }
    }

    @SuppressWarnings("unchecked")
    private Map<ProviderId, ProviderConnection> connections(HttpSession session) {
        Object existing = session.getAttribute(CONNECTIONS_ATTRIBUTE);
        if (existing instanceof Map<?, ?>) {
            return (Map<ProviderId, ProviderConnection>) existing;
        }
        Map<ProviderId, ProviderConnection> created = new EnumMap<>(ProviderId.class);
        session.setAttribute(CONNECTIONS_ATTRIBUTE, created);
        return created;
    }
}
