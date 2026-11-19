package com.tunebridge.security;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ReadListener;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletInputStream;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import jakarta.servlet.http.HttpServletResponse;
import java.io.BufferedReader;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.springframework.web.filter.OncePerRequestFilter;

final class ApiBodyLimitFilter extends OncePerRequestFilter {
    static final int MAX_BODY_BYTES = 64 * 1024;

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        if (!DeploymentPolicy.isApiMutation(request)) {
            chain.doFilter(request, response);
            return;
        }
        if (request.getContentLengthLong() > MAX_BODY_BYTES) {
            SecurityResponses.error(response, 413, "REQUEST_TOO_LARGE");
            return;
        }
        String encoding = request.getHeader("Content-Encoding");
        if (encoding != null && !encoding.equalsIgnoreCase("identity")) {
            SecurityResponses.error(response, 415, "UNSUPPORTED_ENCODING");
            return;
        }
        // Enforce the real byte count, including unknown Content-Length/chunked requests.
        // This happens before any servlet form-parameter parsing or authentication work.
        byte[] body = request.getInputStream().readNBytes(MAX_BODY_BYTES + 1);
        if (body.length > MAX_BODY_BYTES) {
            SecurityResponses.error(response, 413, "REQUEST_TOO_LARGE");
            return;
        }
        BufferedRequest bounded;
        try {
            bounded = new BufferedRequest(request, body);
        } catch (IllegalArgumentException ex) {
            SecurityResponses.error(response, 400, "INVALID_INPUT");
            return;
        }
        chain.doFilter(bounded, response);
    }

    private static final class BufferedRequest extends HttpServletRequestWrapper {
        private final byte[] body;
        private final Map<String, String[]> parameters;

        private BufferedRequest(HttpServletRequest request, byte[] body) {
            super(request);
            this.body = body;
            Map<String, List<String>> values = new LinkedHashMap<>();
            String query = request.getQueryString();
            if (query != null && query.length() > 8192) {
                throw new IllegalArgumentException("Query too large");
            }
            parse(query, values);
            String contentType = request.getContentType();
            if (contentType != null && contentType.split(";", 2)[0].trim().toLowerCase(Locale.ROOT)
                    .equals("application/x-www-form-urlencoded")) {
                parse(new String(body, StandardCharsets.UTF_8), values);
            }
            Map<String, String[]> converted = new LinkedHashMap<>();
            values.forEach((key, value) -> converted.put(key, value.toArray(String[]::new)));
            if (body.length == 0) {
                // Safe only after proving the body is empty (also supports servlet/mock supplied parameters).
                request.getParameterMap().forEach(converted::putIfAbsent);
            }
            parameters = Collections.unmodifiableMap(converted);
        }

        private static void parse(String encoded, Map<String, List<String>> values) {
            if (encoded == null || encoded.isEmpty()) {
                return;
            }
            for (String part : encoded.split("&")) {
                if (values.size() >= 128) {
                    throw new IllegalArgumentException("Too many parameters");
                }
                String[] pair = part.split("=", 2);
                String name = URLDecoder.decode(pair[0], StandardCharsets.UTF_8);
                String value = pair.length == 1 ? "" : URLDecoder.decode(pair[1], StandardCharsets.UTF_8);
                values.computeIfAbsent(name, ignored -> new ArrayList<>()).add(value);
            }
        }

        @Override
        public ServletInputStream getInputStream() {
            ByteArrayInputStream input = new ByteArrayInputStream(body);
            return new ServletInputStream() {
                @Override
                public int read() {
                    return input.read();
                }

                @Override
                public int read(byte[] bytes, int offset, int length) {
                    return input.read(bytes, offset, length);
                }

                @Override
                public boolean isFinished() {
                    return input.available() == 0;
                }

                @Override
                public boolean isReady() {
                    return true;
                }

                @Override
                public void setReadListener(ReadListener listener) {
                    try {
                        if (!isFinished()) {
                            listener.onDataAvailable();
                        }
                        if (isFinished()) {
                            listener.onAllDataRead();
                        }
                    } catch (IOException ex) {
                        listener.onError(ex);
                    }
                }
            };
        }

        @Override
        public BufferedReader getReader() {
            return new BufferedReader(new InputStreamReader(getInputStream(), StandardCharsets.UTF_8));
        }

        @Override
        public String getCharacterEncoding() {
            return StandardCharsets.UTF_8.name();
        }

        @Override
        public String getParameter(String name) {
            String[] values = parameters.get(name);
            return values == null || values.length == 0 ? null : values[0];
        }

        @Override
        public Map<String, String[]> getParameterMap() {
            return parameters;
        }

        @Override
        public Enumeration<String> getParameterNames() {
            return Collections.enumeration(parameters.keySet());
        }

        @Override
        public String[] getParameterValues(String name) {
            String[] values = parameters.get(name);
            return values == null ? null : values.clone();
        }
    }
}
