package com.tunebridge.testsupport;

import com.tunebridge.security.AccountPrincipal;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders;
import org.springframework.test.web.servlet.request.RequestPostProcessor;

import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.csrf;

/**
 * Request builders that satisfy the loopback deployment boundary, CSRF, and account authentication,
 * so MockMvc tests traverse the same filters as a browser on http://localhost:8080.
 */
public final class BridgeRequests {

    public static final int PORT = 8080;
    public static final String HOST = "localhost:" + PORT;

    private BridgeRequests() {
    }

    public static MockHttpServletRequestBuilder get(String path) {
        return loopback(MockMvcRequestBuilders.get(path));
    }

    public static MockHttpServletRequestBuilder post(String path) {
        return loopback(MockMvcRequestBuilders.post(path).with(csrf().asHeader()));
    }

    public static MockHttpServletRequestBuilder delete(String path) {
        return loopback(MockMvcRequestBuilders.delete(path).with(csrf().asHeader()));
    }

    /** Same as {@link #post} but without the CSRF token, for rejection tests. */
    public static MockHttpServletRequestBuilder unguardedPost(String path) {
        return loopback(MockMvcRequestBuilders.post(path));
    }

    /** Form-encoded request, used by the Spring Security login and logout endpoints. */
    public static MockHttpServletRequestBuilder form(String path) {
        return post(path).header("Content-Type", "application/x-www-form-urlencoded");
    }

    public static MockHttpServletRequestBuilder as(MockHttpServletRequestBuilder builder, AccountPrincipal account) {
        return builder.with(authentication(new UsernamePasswordAuthenticationToken(
                account, account.getPassword(), account.getAuthorities())));
    }

    public static RequestPostProcessor loopback() {
        return (request) -> {
            request.setRemoteAddr("127.0.0.1");
            request.setLocalAddr("127.0.0.1");
            request.setLocalPort(PORT);
            request.setServerName("localhost");
            request.setScheme("http");
            request.setSecure(false);
            request.addHeader("Host", HOST);
            return request;
        };
    }

    private static MockHttpServletRequestBuilder loopback(MockHttpServletRequestBuilder builder) {
        return builder.with(loopback());
    }
}
