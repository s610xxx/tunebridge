package com.tunebridge.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "tunebridge")
public class TuneBridgeProperties {

    private final Apple apple = new Apple();
    private final Migration migration = new Migration();
    private final Demo demo = new Demo();

    public Apple getApple() {
        return apple;
    }

    public Migration getMigration() {
        return migration;
    }

    public Demo getDemo() {
        return demo;
    }

    public static class Apple {
        private String developerToken = "";
        private String teamId = "";
        private String keyId = "";
        private String privateKeyPath = "";
        private String defaultStorefront = "cn";

        public String getDeveloperToken() {
            return developerToken;
        }

        public void setDeveloperToken(String developerToken) {
            this.developerToken = developerToken;
        }

        public String getTeamId() {
            return teamId;
        }

        public void setTeamId(String teamId) {
            this.teamId = teamId;
        }

        public String getKeyId() {
            return keyId;
        }

        public void setKeyId(String keyId) {
            this.keyId = keyId;
        }

        public String getPrivateKeyPath() {
            return privateKeyPath;
        }

        public void setPrivateKeyPath(String privateKeyPath) {
            this.privateKeyPath = privateKeyPath;
        }

        public String getDefaultStorefront() {
            return defaultStorefront;
        }

        public void setDefaultStorefront(String defaultStorefront) {
            this.defaultStorefront = defaultStorefront;
        }
    }

    public static class Migration {
        private int maxTracks = 200;
        private int batchSize = 100;
        private long requestIntervalMs = 120;

        public int getMaxTracks() {
            return maxTracks;
        }

        public void setMaxTracks(int maxTracks) {
            this.maxTracks = maxTracks;
        }

        public int getBatchSize() {
            return batchSize;
        }

        public void setBatchSize(int batchSize) {
            this.batchSize = batchSize;
        }

        public long getRequestIntervalMs() {
            return requestIntervalMs;
        }

        public void setRequestIntervalMs(long requestIntervalMs) {
            this.requestIntervalMs = requestIntervalMs;
        }
    }

    public static class Demo {
        private boolean enabled = true;

        public boolean isEnabled() {
            return enabled;
        }

        public void setEnabled(boolean enabled) {
            this.enabled = enabled;
        }
    }
}
