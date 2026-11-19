package com.tunebridge.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "tunebridge.security")
public class SecurityProperties {
    public enum Mode { LOCAL, PUBLIC }

    private Mode mode = Mode.LOCAL;
    private String publicOrigin = "";
    private String registrationCode = "";

    public Mode getMode() {
        return mode;
    }

    public void setMode(Mode mode) {
        this.mode = mode;
    }

    public String getPublicOrigin() {
        return publicOrigin;
    }

    public void setPublicOrigin(String publicOrigin) {
        this.publicOrigin = publicOrigin;
    }

    public String getRegistrationCode() {
        return registrationCode;
    }

    public void setRegistrationCode(String registrationCode) {
        this.registrationCode = registrationCode;
    }
}
