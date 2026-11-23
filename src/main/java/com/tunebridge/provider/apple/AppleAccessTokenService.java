package com.tunebridge.provider.apple;

import org.springframework.stereotype.Component;

/**
 * 决定 Apple 请求用哪个访问令牌签名：运维配置了开发者令牌就走官方通道，
 * 否则退回 Apple 网页播放器自带的令牌，只保留读取能力。
 */
@Component
public class AppleAccessTokenService {

    private final AppleDeveloperTokenService developer;
    private final AppleWebTokenService web;

    public AppleAccessTokenService(AppleDeveloperTokenService developer, AppleWebTokenService web) {
        this.developer = developer;
        this.web = web;
    }

    public Access access() {
        return developer.configured() ? new Access(developer.token(), false) : new Access(web.token(), true);
    }

    /** 写入 Apple 需要开发者账号签发的令牌，非官方通道不放行。 */
    public boolean writesAllowed() {
        return developer.configured();
    }

    public record Access(String bearer, boolean unofficial) {
    }
}
