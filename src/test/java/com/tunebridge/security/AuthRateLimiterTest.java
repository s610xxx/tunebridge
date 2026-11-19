package com.tunebridge.security;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import org.junit.jupiter.api.Test;

class AuthRateLimiterTest {

    private static final Duration WINDOW = Duration.ofMinutes(1);

    @Test
    void capsEachAddressInsideTheWindowAndRefusesToTrackUnboundedSources() {
        MutableClock clock = new MutableClock(Instant.EPOCH);
        AuthRateLimiter limiter = new AuthRateLimiter(3, 1_000, 3, WINDOW, clock);

        for (int attempt = 0; attempt < 3; attempt++) {
            assertThat(limiter.allow("198.51.100.1")).isTrue();
        }
        assertThat(limiter.allow("198.51.100.1")).isFalse();
        assertThat(limiter.allow("198.51.100.2")).isTrue();
        assertThat(limiter.allow("198.51.100.3")).isTrue();
        // The tracked-address cap keeps memory bounded instead of admitting new sources.
        assertThat(limiter.allow("198.51.100.4")).isFalse();
        assertThat(limiter.trackedAddresses()).isEqualTo(3);
        assertThat(limiter.allow("198.51.100.2")).as("already tracked, so still rate-limited per address")
                .isTrue();
        assertThat(limiter.trackedAddresses()).isEqualTo(3);
    }

    @Test
    void boundsTotalAttemptsAndResetsWhenTheWindowRollsOver() {
        MutableClock clock = new MutableClock(Instant.EPOCH);
        AuthRateLimiter limiter = new AuthRateLimiter(2, 3, 100, WINDOW, clock);

        assertThat(limiter.allow("198.51.100.1")).isTrue();
        assertThat(limiter.allow("198.51.100.2")).isTrue();
        assertThat(limiter.allow("198.51.100.3")).isTrue();
        // Global budget spent, even though every address is under its own cap.
        assertThat(limiter.allow("198.51.100.1")).isFalse();

        clock.advance(WINDOW.plusSeconds(1));
        assertThat(limiter.allow("198.51.100.1")).isTrue();
    }

    @Test
    void restartsTheWindowWhenTheClockGoesBackwards() {
        MutableClock clock = new MutableClock(Instant.EPOCH.plusSeconds(600));
        AuthRateLimiter limiter = new AuthRateLimiter(1, 10, 100, WINDOW, clock);

        assertThat(limiter.allow("198.51.100.1")).isTrue();
        assertThat(limiter.allow("198.51.100.1")).isFalse();

        clock.advance(Duration.ofSeconds(-60));
        assertThat(limiter.allow("198.51.100.1")).isTrue();
    }

    @Test
    void refusesMisconfiguredLimitsInsteadOfFailingOpen() {
        MutableClock clock = new MutableClock(Instant.EPOCH);
        for (int[] limits : new int[][]{{0, 10, 10}, {1, 0, 10}, {1, 10, 0}}) {
            assertThatThrownBy(() -> new AuthRateLimiter(limits[0], limits[1], limits[2], WINDOW, clock))
                    .isInstanceOf(IllegalArgumentException.class);
        }
        assertThatThrownBy(() -> new AuthRateLimiter(1, 1, 1, Duration.ZERO, clock))
                .isInstanceOf(IllegalArgumentException.class);
    }

    private static final class MutableClock extends Clock {
        private Instant now;

        private MutableClock(Instant start) {
            this.now = start;
        }

        private void advance(Duration amount) {
            now = now.plus(amount);
        }

        @Override
        public ZoneId getZone() {
            return ZoneOffset.UTC;
        }

        @Override
        public Clock withZone(ZoneId zone) {
            return this;
        }

        @Override
        public Instant instant() {
            return now;
        }
    }
}
