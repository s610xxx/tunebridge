package com.tunebridge.provider.netease;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.tunebridge.provider.ProviderException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

class NeteaseLocalAccessTest {

    private static final String CODE = "abcdefghijklmnopqrstuvwxyzABCDEF0123456789";

    @TempDir
    Path temp;

    @Test
    void disabledByDefaultAndRequiresLoopbackAndValidPaths() throws Exception {
        NeteaseLocalAccess disabled = new NeteaseLocalAccess("", "", "none", "", "");
        disabled.validateConfiguration();
        assertThat(disabled.enabled()).isFalse();
        assertThatThrownBy(() -> disabled.authorize(CODE)).isInstanceOf(ProviderException.class);

        Path node = Files.createFile(temp.resolve("node"));
        Path cli = Files.createFile(temp.resolve("cli.js"));
        assertThatThrownBy(() -> new NeteaseLocalAccess(CODE, "0.0.0.0", "none", node.toString(), cli.toString())
                .validateConfiguration()).isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> new NeteaseLocalAccess("weak", "127.0.0.1", "none", node.toString(), cli.toString())
                .validateConfiguration()).isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> new NeteaseLocalAccess(CODE, "127.0.0.1", "none", "missing", cli.toString())
                .validateConfiguration()).isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> new NeteaseLocalAccess(CODE, "127.0.0.1", "framework", node.toString(), cli.toString())
                .validateConfiguration()).isInstanceOf(IllegalStateException.class);
    }

    @Test
    void grantsAreSeparateAndRevoked() throws Exception {
        Path node = Files.createFile(temp.resolve("node"));
        Path cli = Files.createFile(temp.resolve("cli.js"));
        NeteaseLocalAccess access = new NeteaseLocalAccess(CODE, "127.0.0.1", "none", node.toString(), cli.toString());
        access.validateConfiguration();
        assertThatThrownBy(() -> access.authorize("wrong")).isInstanceOf(ProviderException.class);
        String first = access.authorize(CODE);
        String second = access.authorize(CODE);
        assertThat(first).isNotEqualTo(second);
        assertThat(access.withGrant(first, () -> "ok")).isEqualTo("ok");
        access.revoke(first);
        assertThatThrownBy(() -> access.withGrant(first, () -> "bad")).isInstanceOf(ProviderException.class);
        assertThat(access.withGrant(second, () -> "ok")).isEqualTo("ok");
    }

    @Test
    void localGuardRequiresLoopbackHostAndSameOrigin() throws Exception {
        NeteaseLocalAccess access = mock(NeteaseLocalAccess.class);
        when(access.enabled()).thenReturn(true);
        NeteaseLocalGuard guard = new NeteaseLocalGuard(access);

        MockHttpServletRequest good = request("POST");
        good.addHeader("Origin", "http://localhost:8080");
        MockFilterChain chain = new MockFilterChain();
        MockHttpServletResponse response = new MockHttpServletResponse();
        guard.doFilter(good, response, chain);
        assertThat(chain.getRequest()).isSameAs(good);
        assertThat(response.getHeader("X-Frame-Options")).isEqualTo("DENY");

        MockHttpServletRequest remote = request("GET");
        remote.setRemoteAddr("203.0.113.1");
        remote.addHeader("X-Forwarded-For", "127.0.0.1");
        assertRejected(guard, remote);

        MockHttpServletRequest badHost = request("GET");
        badHost.removeHeader("Host");
        badHost.addHeader("Host", "attacker.example:8080");
        assertRejected(guard, badHost);

        MockHttpServletRequest noOrigin = request("POST");
        assertRejected(guard, noOrigin);

        MockHttpServletRequest crossOrigin = request("POST");
        crossOrigin.addHeader("Origin", "http://attacker.example:8080");
        assertRejected(guard, crossOrigin);

        MockHttpServletRequest crossSite = request("GET");
        crossSite.addHeader("Sec-Fetch-Site", "cross-site");
        assertRejected(guard, crossSite);

        MockHttpServletRequest forwarded = request("GET");
        forwarded.addHeader("Forwarded", "for=203.0.113.1");
        assertRejected(guard, forwarded);
    }

    private static MockHttpServletRequest request(String method) {
        MockHttpServletRequest request = new MockHttpServletRequest(method, "/api/state");
        request.setRemoteAddr("127.0.0.1");
        request.setLocalAddr("127.0.0.1");
        request.setLocalPort(8080);
        request.setScheme("http");
        request.addHeader("Host", "localhost:8080");
        return request;
    }

    private static void assertRejected(NeteaseLocalGuard guard, MockHttpServletRequest request) throws Exception {
        MockHttpServletResponse response = new MockHttpServletResponse();
        MockFilterChain chain = new MockFilterChain();
        guard.doFilter(request, response, chain);
        assertThat(response.getStatus()).isEqualTo(403);
        assertThat(chain.getRequest()).isNull();
    }
}
