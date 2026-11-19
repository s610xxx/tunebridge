package com.tunebridge.provider.netease;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.tunebridge.domain.CreatedPlaylist;
import com.tunebridge.domain.Track;
import com.tunebridge.provider.ProviderException;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;

@Component
public class NeteaseMusicClient {
    private static final int MAX_OUTPUT = 1024 * 1024;
    private static final int MAX_TRACKS = 200;
    private static final int PAGE_SIZE = 50;
    private static final Semaphore PROCESSES = new Semaphore(2);
    private static final String UNVERIFIED = "网易云歌单写入未验证，请检查目标歌单后手动处理，勿自动重试";
    private static final String ORDER_UNVERIFIED = "网易云歌曲已写入，但顺序与来源不一致，请检查目标歌单后手动处理，勿自动重试";
    private final ObjectMapper mapper;
    private final CommandExecutor executor;

    @FunctionalInterface
    interface CommandExecutor {
        String execute(List<String> arguments);
    }

    @Autowired
    public NeteaseMusicClient(ObjectMapper mapper,
            @Value("${tunebridge.netease.cli-entry:}") String cliEntry,
            @Value("${tunebridge.netease.node-executable:}") String nodeExecutable) {
        this(mapper, arguments -> runProcess(nodeExecutable, cliEntry, arguments));
    }

    NeteaseMusicClient(ObjectMapper mapper, CommandExecutor executor) {
        this.mapper = mapper;
        this.executor = executor;
    }

    public void validateLogin() {
        JsonNode data = call(List.of("playlist", "created", "--limit=1", "--output=json"));
        if (data.isMissingNode() || data.isNull()) {
            throw ProviderException.upstream("网易云登录状态检查失败");
        }
    }

    public List<Track> searchTracks(String title, String artist, int limit) {
        String safeTitle = input(title, 256, true);
        String safeArtist = input(artist == null ? "" : artist, 256, false);
        String keyword = (safeTitle + " " + safeArtist).trim();
        int cappedLimit = Math.max(1, Math.min(100, limit));
        JsonNode records = call(List.of("search", "song", "--keyword=" + keyword,
                "--limit=" + cappedLimit, "--output=json")).path("records");
        if (!records.isArray()) {
            throw ProviderException.upstream("网易云搜索响应格式无效");
        }
        List<Track> result = new ArrayList<>();
        for (JsonNode song : records) {
            String id = text(song, "id");
            String name = text(song, "name");
            if (!validToken(id) || name.isBlank()) {
                continue;
            }
            List<String> artists = new ArrayList<>();
            if (song.path("artists").isArray()) {
                for (JsonNode item : song.path("artists")) {
                    String value = text(item, "name");
                    if (!value.isBlank()) artists.add(value);
                }
            }
            long duration = song.path("duration").asLong(0);
            int seconds = (int) Math.min(Integer.MAX_VALUE, Math.max(0L, duration / 1000));
            result.add(new Track(id, name, String.join(" / ", artists), text(song.path("album"), "name"),
                    seconds, text(song, "coverImgUrl"), 0));
            if (result.size() == cappedLimit) break;
        }
        return List.copyOf(result);
    }

    public CreatedPlaylist createPlaylist(String name) {
        String safeName = input(name, 256, true);
        try {
            JsonNode data = call(List.of("playlist", "create", "--playlistName=" + safeName, "--output=json"));
            String id = text(data, "id");
            if (!validToken(id)) throw ProviderException.upstream("网易云未返回有效歌单 ID");
            String returnedName = text(data, "name");
            String originalId = text(data, "originalId");
            String url = originalId.matches("[0-9]{1,20}")
                    ? "https://music.163.com/#/playlist?id=" + originalId : "";
            return new CreatedPlaylist(id, returnedName.isBlank() ? safeName : returnedName, url, 0, Map.of());
        } catch (RuntimeException ex) {
            throw ProviderException.upstream("网易云歌单创建结果未确认，请检查目标歌单后手动处理，勿自动重试");
        }
    }

    public void addTracks(CreatedPlaylist playlist, List<Track> tracks) {
        if (playlist == null || !validToken(playlist.id()) || tracks == null || tracks.size() > MAX_TRACKS) {
            throw ProviderException.badRequest("网易云歌单或歌曲数量无效（最多 200 首）");
        }
        List<String> expected = new ArrayList<>();
        for (Track track : tracks) {
            if (track == null || !validToken(track.providerTrackId())) {
                throw ProviderException.badRequest("网易云歌曲 ID 无效");
            }
            expected.add(track.providerTrackId());
        }
        if (new HashSet<>(expected).size() != expected.size()) {
            throw ProviderException.upstream(UNVERIFIED);
        }
        if (expected.isEmpty()) return;
        try {
            // NetEase prepends songs, so insert reversed batches from the end.
            for (int end = expected.size(); end > 0; end -= PAGE_SIZE) {
                int start = Math.max(0, end - PAGE_SIZE);
                String ids = mapper.writeValueAsString(expected.subList(start, end).reversed());
                JsonNode response = call(List.of("playlist", "add", "--playlistId=" + playlist.id(),
                        "--songIdList=" + ids, "--output=json"));
                if (!response.isArray()) throw ProviderException.upstream(UNVERIFIED);
                verify(playlist.id(), expected.subList(start, expected.size()));
            }
        } catch (ProviderException ex) {
            if ("NETEASE_ORDER_MISMATCH".equals(ex.code())) {
                throw new ProviderException(HttpStatus.BAD_GATEWAY, "NETEASE_ORDER_MISMATCH", ORDER_UNVERIFIED);
            }
            throw ProviderException.upstream(UNVERIFIED);
        } catch (Exception ex) {
            throw ProviderException.upstream(UNVERIFIED);
        }
    }

    private void verify(String playlistId, List<String> expected) {
        List<String> actual = new ArrayList<>();
        int offset = 0;
        while (offset <= MAX_TRACKS) {
            JsonNode page = call(List.of("playlist", "tracks", "--playlistId=" + playlistId,
                    "--limit=" + PAGE_SIZE, "--offset=" + offset, "--output=json"));
            if (!page.isArray() || page.size() > PAGE_SIZE) throw ProviderException.upstream(UNVERIFIED);
            if (page.isEmpty()) break;
            for (JsonNode song : page) {
                String id = text(song, "id");
                if (!validToken(id)) throw ProviderException.upstream(UNVERIFIED);
                actual.add(id);
                if (actual.size() > expected.size()) throw ProviderException.upstream(UNVERIFIED);
            }
            offset += page.size();
        }
        if (!actual.equals(expected)) {
            if (actual.size() == expected.size() && new HashSet<>(actual).equals(new HashSet<>(expected))) {
                throw new ProviderException(HttpStatus.BAD_GATEWAY, "NETEASE_ORDER_MISMATCH", ORDER_UNVERIFIED);
            }
            throw ProviderException.upstream(UNVERIFIED);
        }
    }

    private JsonNode call(List<String> arguments) {
        String output;
        try {
            output = executor.execute(List.copyOf(arguments));
        } catch (ProviderException ex) {
            throw new ProviderException(ex.status(), ex.code(), "网易云 CLI 执行失败或不可用");
        } catch (RuntimeException ex) {
            throw ProviderException.upstream("网易云 CLI 执行失败或不可用");
        }
        if (output == null || output.length() > MAX_OUTPUT) throw ProviderException.upstream("网易云响应无效");
        try {
            JsonNode root = mapper.readTree(output);
            if (root == null || !root.path("code").isIntegralNumber() || root.path("code").asInt() != 200) {
                throw ProviderException.upstream("网易云请求失败");
            }
            return root.path("data");
        } catch (ProviderException ex) {
            throw ex;
        } catch (Exception ex) {
            throw ProviderException.upstream("网易云响应格式无效");
        }
    }

    private static String text(JsonNode node, String field) {
        JsonNode value = node.path(field);
        return value.isTextual() || value.isNumber() ? value.asText() : "";
    }

    private static boolean validToken(String value) {
        return value != null && value.matches("[A-Za-z0-9_+=/-]{1,256}");
    }

    private static String input(String value, int maximum, boolean required) {
        if (value == null || value.length() > maximum || value.codePoints().anyMatch(Character::isISOControl)
                || (required && value.isBlank())) {
            throw ProviderException.badRequest("网易云输入无效或过长");
        }
        return value;
    }

    private static String runProcess(String node, String entry, List<String> arguments) {
        if (!absoluteFile(node) || !absoluteFile(entry)) {
            throw ProviderException.notConfigured("网易云 CLI 路径未配置或无效");
        }
        if (!PROCESSES.tryAcquire()) throw ProviderException.rateLimited("网易云 CLI 正忙，请稍后再试");
        Process process = null;
        try {
            List<String> command = new ArrayList<>();
            command.add(node);
            command.add(entry);
            arguments.stream().map(NeteaseMusicClient::processArgument).forEach(command::add);
            process = new ProcessBuilder(command).redirectError(ProcessBuilder.Redirect.DISCARD).start();
            Process child = process;
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            boolean[] overflow = {false};
            Thread reader = Thread.ofVirtual().start(() -> {
                try (InputStream in = child.getInputStream()) {
                    byte[] buffer = new byte[8192];
                    int count;
                    while ((count = in.read(buffer)) != -1) {
                        if (output.size() + count > MAX_OUTPUT) {
                            overflow[0] = true;
                            child.destroyForcibly();
                            break;
                        }
                        output.write(buffer, 0, count);
                    }
                } catch (Exception ex) {
                    overflow[0] = true;
                }
            });
            if (!process.waitFor(30, TimeUnit.SECONDS)) {
                process.destroyForcibly();
                throw ProviderException.upstream("网易云 CLI 执行超时");
            }
            reader.join(2000);
            if (reader.isAlive() || overflow[0] || process.exitValue() != 0) {
                throw ProviderException.upstream("网易云 CLI 执行失败或响应过长");
            }
            return output.toString(StandardCharsets.UTF_8);
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            throw ProviderException.upstream("网易云 CLI 执行中断");
        } catch (java.io.IOException ex) {
            throw ProviderException.upstream("网易云 CLI 无法启动");
        } finally {
            if (process != null && process.isAlive()) process.destroyForcibly();
            PROCESSES.release();
        }
    }

    private static String processArgument(String argument) {
        if (File.separatorChar != '\\') return argument;
        // Windows reparses a command line, so embedded quotes must survive Node's argv parsing.
        StringBuilder quoted = new StringBuilder("\"");
        int backslashes = 0;
        for (char ch : argument.toCharArray()) {
            if (ch == '\\') {
                backslashes++;
                continue;
            }
            quoted.append("\\".repeat(ch == '"' ? 2 * backslashes + 1 : backslashes)).append(ch);
            backslashes = 0;
        }
        return quoted.append("\\".repeat(2 * backslashes)).append('"').toString();
    }

    private static boolean absoluteFile(String value) {
        try {
            return value != null && Path.of(value).isAbsolute() && Files.isRegularFile(Path.of(value));
        } catch (RuntimeException ex) {
            return false;
        }
    }
}
