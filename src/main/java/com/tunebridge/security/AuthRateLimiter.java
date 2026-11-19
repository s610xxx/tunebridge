package com.tunebridge.security;

import java.time.Clock;
import java.time.Duration;
import java.util.HashMap;
import java.util.Map;

public final class AuthRateLimiter {
    private final int perAddressLimit;
    private final int globalLimit;
    private final int maxAddresses;
    private final long windowMillis;
    private final Clock clock;
    private final Map<String, Integer> attempts = new HashMap<>();
    private long windowStart;
    private int total;

    public AuthRateLimiter() {
        this(60, 2_000, 4_096, Duration.ofMinutes(1), Clock.systemUTC());
    }

    public AuthRateLimiter(int perAddressLimit, int globalLimit, int maxAddresses, Duration window, Clock clock) {
        if (perAddressLimit <= 0 || globalLimit <= 0 || maxAddresses <= 0 || window.toMillis() <= 0) {
            throw new IllegalArgumentException("Rate limits must be positive");
        }
        this.perAddressLimit = perAddressLimit;
        this.globalLimit = globalLimit;
        this.maxAddresses = maxAddresses;
        this.windowMillis = window.toMillis();
        this.clock = clock;
        this.windowStart = clock.millis();
    }

    public synchronized boolean allow(String remoteAddress) {
        long now = clock.millis();
        if (now - windowStart >= windowMillis || now < windowStart) {
            attempts.clear();
            total = 0;
            windowStart = now;
        }
        if (total >= globalLimit || (attempts.size() >= maxAddresses && !attempts.containsKey(remoteAddress))) {
            return false;
        }
        int count = attempts.getOrDefault(remoteAddress, 0);
        if (count >= perAddressLimit) {
            return false;
        }
        attempts.put(remoteAddress, count + 1);
        total++;
        return true;
    }

    synchronized int trackedAddresses() {
        return attempts.size();
    }
}
