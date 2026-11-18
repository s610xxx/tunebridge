package com.tunebridge.provider.qq;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.tunebridge.provider.ProviderException;
import org.junit.jupiter.api.Test;

class QqCookieTest {

    @Test
    void parsesUinAndMusicKey() {
        QqCookie cookie = QqCookie.parse("Cookie: uin=o0012345678; qm_keyst=qmkeyst_demo; other=value");

        assertThat(cookie.uin()).isEqualTo("12345678");
        assertThat(cookie.musicKey()).isEqualTo("qmkeyst_demo");
        assertThat(cookie.maskedUin()).isEqualTo("12****78");
        assertThat(cookie.rawCookie()).startsWith("uin=o0012345678");
        assertThat(cookie.rawCookie()).doesNotContain("Cookie:");
        assertThat(cookie.gTk()).isEqualTo(924345111);
    }

    @Test
    void fallsBackToAlternateCookieNames() {
        QqCookie cookie = QqCookie.parse("qqmusic_uin=123456789; qqmusic_key=abc");

        assertThat(cookie.uin()).isEqualTo("123456789");
        assertThat(cookie.musicKey()).isEqualTo("abc");
        assertThat(cookie.gTk()).isEqualTo(193485963);
    }

    @Test
    void rejectsMissingUinOrKey() {
        assertThatThrownBy(() -> QqCookie.parse("qm_keyst=abc"))
                .isInstanceOf(ProviderException.class)
                .hasMessageContaining("缺少 uin");
        assertThatThrownBy(() -> QqCookie.parse("uin=123456789"))
                .isInstanceOf(ProviderException.class)
                .hasMessageContaining("缺少音乐登录票据");
    }

    @Test
    void rejectsTooShortCookie() {
        assertThatThrownBy(() -> QqCookie.parse("uin=123"))
                .isInstanceOf(ProviderException.class)
                .hasMessageContaining("Cookie 格式不完整");
    }
}
