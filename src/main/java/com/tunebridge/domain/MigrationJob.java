package com.tunebridge.domain;

import java.time.Instant;
import java.time.LocalTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;

public class MigrationJob {

    private static final DateTimeFormatter TIME_FORMAT = DateTimeFormatter.ofPattern("HH:mm:ss");
    private static final int MAX_LOGS = 240;

    private final String id;
    private final String sessionId;
    private final ProviderId sourceProvider;
    private final ProviderId targetProvider;
    private final String sourceUrl;
    private final String requestedName;
    private final String sourceLabel;
    private final Instant createdAt = Instant.now();

    private final List<LogEntry> logs = new ArrayList<>();
    private final List<TrackMatch> matches = new ArrayList<>();

    private volatile JobStatus status = JobStatus.QUEUED;
    private volatile int progress;
    private volatile String currentStep = "等待开始";
    private volatile Playlist sourcePlaylist;
    private volatile CreatedPlaylist result;
    private volatile String error = "";

    public MigrationJob(String id, String sessionId, ProviderId sourceProvider, ProviderId targetProvider,
                        String sourceUrl, String requestedName) {
        this(id, sessionId, sourceProvider, targetProvider, sourceUrl, requestedName, null);
    }

    public MigrationJob(String id, String sessionId, ProviderId sourceProvider, ProviderId targetProvider,
                        String sourceUrl, String requestedName, String sourceLabel) {
        this.id = id;
        this.sessionId = sessionId;
        this.sourceProvider = sourceProvider;
        this.targetProvider = targetProvider;
        this.sourceUrl = sourceUrl;
        this.requestedName = requestedName;
        this.sourceLabel = sourceLabel;
    }

    public synchronized void start() {
        status = JobStatus.RUNNING;
        progress = 2;
        currentStep = "准备迁移";
        log("迁移任务已创建，正在读取来源歌单", "INFO");
    }

    public synchronized void step(String text, int newProgress) {
        currentStep = text;
        progress = Math.max(progress, Math.min(99, newProgress));
    }

    public synchronized void progress(int newProgress) {
        progress = Math.max(progress, Math.min(100, newProgress));
    }

    public synchronized void log(String message, String level) {
        logs.add(new LogEntry(LocalTime.now().format(TIME_FORMAT), message, level));
        if (logs.size() > MAX_LOGS) {
            logs.remove(0);
        }
    }

    public synchronized void sourceLoaded(Playlist playlist) {
        sourcePlaylist = playlist;
        log("已读取《" + playlist.name() + "》，共 " + playlist.tracks().size() + " 首", "SUCCESS");
    }

    public synchronized void addMatch(TrackMatch match) {
        matches.add(match);
    }

    public synchronized void complete(CreatedPlaylist createdPlaylist) {
        result = createdPlaylist;
        status = JobStatus.COMPLETED;
        progress = 100;
        currentStep = "迁移完成";
        log("迁移完成：成功写入 " + createdPlaylist.trackCount() + " 首", "SUCCESS");
    }

    public synchronized void fail(String message) {
        error = message;
        status = JobStatus.FAILED;
        currentStep = "迁移失败";
        log(message, "ERROR");
    }

    public synchronized List<LogEntry> logsSnapshot() {
        return List.copyOf(logs);
    }

    public synchronized List<TrackMatch> matchesSnapshot() {
        return List.copyOf(matches);
    }

    public String id() {
        return id;
    }

    public String sessionId() {
        return sessionId;
    }

    public ProviderId sourceProvider() {
        return sourceProvider;
    }

    public ProviderId targetProvider() {
        return targetProvider;
    }

    public String sourceUrl() {
        return sourceUrl;
    }

    public String requestedName() {
        return requestedName;
    }

    public String sourceLabel() {
        return sourceLabel;
    }

    public JobStatus status() {
        return status;
    }

    public int progress() {
        return progress;
    }

    public String currentStep() {
        return currentStep;
    }

    public Playlist sourcePlaylist() {
        return sourcePlaylist;
    }

    public CreatedPlaylist result() {
        return result;
    }

    public String error() {
        return error;
    }

    public Instant createdAt() {
        return createdAt;
    }
}
