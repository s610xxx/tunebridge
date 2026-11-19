package com.tunebridge.security;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.tunebridge.config.SecurityProperties;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.mock.env.MockEnvironment;
import org.springframework.mock.web.MockHttpServletRequest;

class DeploymentPolicyTest {

    private static final String CODE = "k".repeat(40);

    @Test
    void localModeRefusesToStartOnAnInterfaceAnyoneCouldReach() {
        assertThatThrownBy(() -> new DeploymentPolicy(local(), environment(localProperties(),
                Map.of("server.address", "0.0.0.0"))))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("127.0.0.1");

        assertThatThrownBy(() -> new DeploymentPolicy(local(), environment(localProperties(),
                Map.of("server.forward-headers-strategy", "native"))))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("reverse proxies");
    }

    @Test
    void localModeOnlyTrustsLoopbackRequestsAddressedToTheLocalOrigin() {
        DeploymentPolicy policy = new DeploymentPolicy(local(), environment(localProperties(), Map.of()));

        assertThat(policy.allows(localRequest("GET", "/api/state"))).isTrue();
        assertThat(policy.allows(localRequest("POST", "/api/migrations"))).isTrue();

        MockHttpServletRequest remote = localRequest("GET", "/api/state");
        remote.setRemoteAddr("192.0.2.10");
        assertThat(policy.allows(remote)).isFalse();

        MockHttpServletRequest bridged = localRequest("GET", "/api/state");
        bridged.setLocalAddr("192.0.2.10");
        assertThat(policy.allows(bridged)).isFalse();

        MockHttpServletRequest portSpoof = localRequest("GET", "/api/state");
        portSpoof.removeHeader("Host");
        portSpoof.addHeader("Host", "localhost:1");
        assertThat(policy.allows(portSpoof)).isFalse();

        MockHttpServletRequest noHost = localRequest("GET", "/api/state");
        noHost.removeHeader("Host");
        assertThat(policy.allows(noHost)).isFalse();

        for (String header : new String[]{"X-Forwarded-For", "X-Forwarded-Host", "Forwarded", "X-Real-IP"}) {
            MockHttpServletRequest proxied = localRequest("GET", "/api/state");
            proxied.addHeader(header, "203.0.113.9");
            assertThat(policy.allows(proxied)).as(header).isFalse();
        }
    }

    @Test
    void localModeRejectsCrossSiteMutationsButLeavesReadsAlone() {
        DeploymentPolicy policy = new DeploymentPolicy(local(), environment(localProperties(), Map.of()));

        MockHttpServletRequest crossSite = localRequest("POST", "/api/migrations");
        crossSite.addHeader("Origin", "http://localhost:8081");
        assertThat(policy.allows(crossSite)).isFalse();

        MockHttpServletRequest twoOrigins = localRequest("POST", "/api/migrations");
        twoOrigins.addHeader("Origin", "http://localhost:8080");
        twoOrigins.addHeader("Origin", "http://localhost:3000");
        assertThat(policy.allows(twoOrigins)).isFalse();

        MockHttpServletRequest crossSiteFetch = localRequest("POST", "/api/migrations");
        crossSiteFetch.addHeader("Sec-Fetch-Site", "cross-site");
        assertThat(policy.allows(crossSiteFetch)).isFalse();

        MockHttpServletRequest sameOriginRead = localRequest("GET", "/api/state");
        sameOriginRead.addHeader("Origin", "https://evil.example");
        assertThat(policy.allows(sameOriginRead)).isTrue();
    }

    @Test
    void publicModeRequiresNativeTlsSecureCookiesAndAnUnguessableInvite() {
        Map<String, String> base = Map.of(
                "tunebridge.security.registration-code", CODE,
                "tunebridge.security.public-origin", "https://bridge.example",
                "server.ssl.enabled", "true",
                "server.servlet.session.cookie.secure", "true");

        assertThat(new DeploymentPolicy(publicMode("https://bridge.example"), environment(base,
                Map.of("server.address", "0.0.0.0")))).isNotNull();

        assertThatThrownBy(() -> new DeploymentPolicy(publicMode("https://bridge.example"),
                environment(without(base, "server.ssl.enabled"), Map.of())))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("native TLS");
        assertThatThrownBy(() -> new DeploymentPolicy(publicMode("https://bridge.example"),
                environment(without(base, "server.servlet.session.cookie.secure"), Map.of())))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("secure session cookies");
        SecurityProperties weakCode = publicMode("https://bridge.example");
        weakCode.setRegistrationCode("short");
        assertThatThrownBy(() -> new DeploymentPolicy(weakCode,
                environment(withReplaced(base, "tunebridge.security.registration-code", "short"), Map.of())))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("registration code");
        assertThatThrownBy(() -> new DeploymentPolicy(publicMode("https://bridge.example"),
                environment(withReplaced(base, "tunebridge.netease.pairing-code", "hunter2"), Map.of())))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("NetEase pairing");
    }

    @Test
    void publicModeOnlyServesItsCanonicalOriginOverHttps() {
        DeploymentPolicy policy = new DeploymentPolicy(publicMode("https://bridge.example"),
                environment(Map.of(
                        "tunebridge.security.registration-code", CODE,
                        "tunebridge.security.public-origin", "https://bridge.example",
                        "server.ssl.enabled", "true",
                        "server.servlet.session.cookie.secure", "true"), Map.of()));

        MockHttpServletRequest ok = publicRequest("POST", "/api/migrations");
        assertThat(policy.allows(ok)).isTrue();

        MockHttpServletRequest plainHttp = publicRequest("POST", "/api/migrations");
        plainHttp.setScheme("http");
        plainHttp.setSecure(false);
        assertThat(policy.allows(plainHttp)).isFalse();

        MockHttpServletRequest otherHost = publicRequest("POST", "/api/migrations");
        otherHost.removeHeader("Host");
        otherHost.addHeader("Host", "bridge.example.evil");
        assertThat(policy.allows(otherHost)).isFalse();

        MockHttpServletRequest crossSite = publicRequest("POST", "/api/migrations");
        crossSite.addHeader("Origin", "https://evil.example");
        assertThat(policy.allows(crossSite)).isFalse();

        MockHttpServletRequest localOnly = publicRequest("GET", "/api/state");
        localOnly.setRemoteAddr("192.0.2.10");
        assertThat(policy.allows(localOnly)).isTrue();
    }

    @Test
    void publicOriginMustStayCanonical() {
        for (String origin : new String[]{"http://bridge.example", "https://bridge.example/",
                "https://Bridge.example", "https://bridge.example/app", "https://bridge.example?x=1",
                "https://user@bridge.example", "https://bridge.example:443", "https://bridge.example:0",
                "https://bridge.example."}) {
            assertThatThrownBy(() -> new DeploymentPolicy(publicMode(origin), environment(Map.of(
                    "tunebridge.security.registration-code", CODE,
                    "tunebridge.security.public-origin", origin,
                    "server.ssl.enabled", "true",
                    "server.servlet.session.cookie.secure", "true"), Map.of())))
                    .as(origin).isInstanceOf(IllegalStateException.class);
        }
    }

    private static SecurityProperties local() {
        SecurityProperties properties = new SecurityProperties();
        properties.setMode(SecurityProperties.Mode.LOCAL);
        return properties;
    }

    private static SecurityProperties publicMode(String origin) {
        SecurityProperties properties = local();
        properties.setMode(SecurityProperties.Mode.PUBLIC);
        properties.setPublicOrigin(origin);
        properties.setRegistrationCode(CODE);
        return properties;
    }

    private static Map<String, String> localProperties() {
        return Map.of("server.address", "127.0.0.1", "server.forward-headers-strategy", "none");
    }

    private static MockEnvironment environment(Map<String, String> config, Map<String, String> overrides) {
        MockEnvironment environment = new MockEnvironment();
        config.forEach(environment::setProperty);
        overrides.forEach(environment::setProperty);
        return environment;
    }

    private static Map<String, String> without(Map<String, String> source, String key) {
        return withReplaced(source, key, null);
    }

    private static Map<String, String> withReplaced(Map<String, String> source, String key, String value) {
        java.util.Map<String, String> copy = new java.util.LinkedHashMap<>(source);
        if (value == null) {
            copy.remove(key);
        } else {
            copy.put(key, value);
        }
        return copy;
    }

    private static MockHttpServletRequest localRequest(String method, String path) {
        MockHttpServletRequest request = request(method, path);
        request.setRemoteAddr("127.0.0.1");
        request.setLocalAddr("127.0.0.1");
        request.setLocalPort(8080);
        request.setServerName("localhost");
        request.setScheme("http");
        request.addHeader("Host", "localhost:8080");
        return request;
    }

    private static MockHttpServletRequest publicRequest(String method, String path) {
        MockHttpServletRequest request = request(method, path);
        request.setRemoteAddr("198.51.100.7");
        request.setLocalAddr("10.0.0.5");
        request.setLocalPort(443);
        request.setScheme("https");
        request.setSecure(true);
        request.addHeader("Host", "bridge.example");
        return request;
    }

    private static MockHttpServletRequest request(String method, String path) {
        MockHttpServletRequest request = new MockHttpServletRequest(method, path);
        request.setContextPath("");
        return request;
    }
}
