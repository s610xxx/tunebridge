package com.tunebridge.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.tunebridge.domain.JobStatus;
import com.tunebridge.domain.MigrationJob;
import com.tunebridge.domain.ProviderId;
import com.tunebridge.provider.ProviderException;
import com.tunebridge.web.dto.JobView;
import jakarta.annotation.PostConstruct;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import java.util.stream.Stream;
import org.springframework.boot.sql.init.dependency.DependsOnDatabaseInitialization;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.support.TransactionTemplate;

@Repository
@DependsOnDatabaseInitialization
public class MigrationHistory {

    private final JdbcTemplate jdbc;
    private final ObjectMapper mapper;
    private final TransactionTemplate transactions;

    public MigrationHistory(JdbcTemplate jdbc, ObjectMapper mapper, TransactionTemplate transactions) {
        this.jdbc = jdbc;
        this.mapper = mapper;
        this.transactions = transactions;
    }

    @PostConstruct
    public void recoverInterrupted() {
        transactions.executeWithoutResult(status -> {
            var unfinished = jdbc.query("SELECT id, write_started, snapshot FROM migration_history "
                            + "WHERE status IN ('QUEUED', 'RUNNING', 'AWAITING_CONFIRMATION')",
                    (row, index) -> new Recovery(row.getString("id"), row.getBoolean("write_started"),
                            decode(row.getString("snapshot"))));
            for (Recovery row : unfinished) {
                JobView recovered = row.view().interruptedAfterRestart(row.writeStarted());
                jdbc.update("UPDATE migration_history SET status = 'INTERRUPTED', snapshot = ?, "
                        + "updated_at = CURRENT_TIMESTAMP WHERE id = ?", encode(recovered), row.id());
            }
            // Rows written before the provider columns existed keep the truth inside the snapshot.
            var legacy = jdbc.query("SELECT id, snapshot FROM migration_history "
                            + "WHERE source_provider IS NULL OR target_provider IS NULL",
                    (row, index) -> new Providers(row.getString("id"), decode(row.getString("snapshot"))));
            for (Providers row : legacy) {
                jdbc.update("UPDATE migration_history SET source_provider = ?, target_provider = ? WHERE id = ?",
                        row.source(), row.target(), row.id());
            }
        });
    }

    public void save(MigrationJob job) {
        synchronized (job) {
            JobView view = JobView.from(job).asReadOnly();
            jdbc.update("MERGE INTO migration_history (id, owner_id, status, write_started, source_provider, "
                            + "target_provider, snapshot, created_at, updated_at) KEY(id) "
                            + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)",
                    job.id(), job.ownerId(), job.status().name(), job.writeStarted(),
                    view.source().provider(), view.target().provider(), encode(view),
                    OffsetDateTime.ofInstant(job.createdAt(), ZoneOffset.UTC));
        }
    }

    public JobView find(String ownerId, String id) {
        return jdbc.query("SELECT snapshot FROM migration_history WHERE owner_id = ? AND id = ?",
                        (row, index) -> decode(row.getString("snapshot")).asReadOnly(), ownerId, id)
                .stream().findFirst().orElseThrow(() -> ProviderException.notFound("迁移任务不存在"));
    }

    public Page list(String ownerId, int offset, int limit, Filters filters) {
        if (offset < 0 || offset > 100_000 || limit < 1 || limit > 50) {
            throw ProviderException.badRequest("历史记录分页参数无效");
        }
        StringBuilder sql = new StringBuilder("SELECT snapshot FROM migration_history WHERE owner_id = ?");
        List<Object> args = new ArrayList<>();
        args.add(ownerId);
        filters.appendConditions(sql, args);
        sql.append(" ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?");
        args.add(limit + 1);
        args.add(offset);
        List<JobView> rows = jdbc.query(sql.toString(),
                (row, index) -> decode(row.getString("snapshot")).asReadOnly(), args.toArray());
        return new Page(rows.size() > limit ? rows.subList(0, limit) : rows, offset, rows.size() > limit);
    }

    private String encode(JobView view) {
        try {
            return mapper.writeValueAsString(view);
        } catch (JsonProcessingException ex) {
            throw new IllegalStateException("任务报告无法保存");
        }
    }

    private JobView decode(String value) {
        try {
            return mapper.readValue(value, JobView.class);
        } catch (JsonProcessingException ex) {
            throw new IllegalStateException("任务报告无法读取");
        }
    }

    public record Page(List<JobView> items, int offset, boolean hasMore) {
    }

    private record Recovery(String id, boolean writeStarted, JobView view) {
    }

    private record Providers(String id, String source, String target) {
        Providers(String id, JobView view) {
            this(id, view.source().provider(), view.target().provider());
        }
    }

    /** Read-only filter over the persisted history; every field is optional. */
    public record Filters(String source, String target, String status,
                          OffsetDateTime fromInclusive, OffsetDateTime toExclusive) {

        private static final Pattern DATE_ONLY = Pattern.compile("\\d{4}-\\d{2}-\\d{2}");
        private static final Set<String> SOURCES = providers(true);
        private static final Set<String> TARGETS = providers(false);
        private static final Set<String> STATUSES =
                Arrays.stream(JobStatus.values()).map(Enum::name).collect(Collectors.toUnmodifiableSet());

        public static Filters none() {
            return new Filters(null, null, null, null, null);
        }

        public static Filters of(String source, String target, String status, String from, String to) {
            Filters filters = new Filters(oneOf(source, SOURCES, "来源平台"),
                    oneOf(target, TARGETS, "目标平台"),
                    oneOf(status, STATUSES, "任务状态"),
                    boundary(from, false), boundary(to, true));
            if (filters.fromInclusive() != null && filters.toExclusive() != null
                    && !filters.fromInclusive().isBefore(filters.toExclusive())) {
                throw ProviderException.badRequest("开始时间必须早于结束时间");
            }
            return filters;
        }

        void appendConditions(StringBuilder sql, List<Object> args) {
            if (source != null) {
                sql.append(" AND source_provider = ?");
                args.add(source);
            }
            if (target != null) {
                sql.append(" AND target_provider = ?");
                args.add(target);
            }
            if (status != null) {
                sql.append(" AND status = ?");
                args.add(status);
            }
            if (fromInclusive != null) {
                sql.append(" AND created_at >= ?");
                args.add(fromInclusive);
            }
            if (toExclusive != null) {
                sql.append(" AND created_at < ?");
                args.add(toExclusive);
            }
        }

        private static String oneOf(String value, Set<String> allowed, String label) {
            if (value == null || value.isBlank()) {
                return null;
            }
            String normalized = value.trim().toUpperCase(Locale.ROOT);
            if (!allowed.contains(normalized)) {
                throw ProviderException.badRequest("不支持的" + label + "筛选条件");
            }
            return normalized;
        }

        private static OffsetDateTime boundary(String value, boolean upper) {
            if (value == null || value.isBlank()) {
                return null;
            }
            String trimmed = value.trim();
            try {
                if (DATE_ONLY.matcher(trimmed).matches()) {
                    LocalDate day = LocalDate.parse(trimmed);
                    OffsetDateTime start = day.atStartOfDay(ZoneOffset.UTC).toOffsetDateTime();
                    return upper ? start.plusDays(1) : start;
                }
                return OffsetDateTime.parse(trimmed);
            } catch (DateTimeParseException ex) {
                throw ProviderException.badRequest("时间筛选格式无效，请使用 YYYY-MM-DD 或带时区的 ISO 时间");
            }
        }

        private static Set<String> providers(boolean withBackup) {
            Set<String> names = Arrays.stream(ProviderId.values()).map(Enum::name)
                    .collect(Collectors.toUnmodifiableSet());
            return withBackup
                    ? Stream.concat(names.stream(), Stream.of("LOCAL_BACKUP")).collect(Collectors.toUnmodifiableSet())
                    : names;
        }
    }
}
