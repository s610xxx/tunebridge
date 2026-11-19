package com.tunebridge.config;

import com.tunebridge.provider.demo.DemoStore;
import com.tunebridge.service.MigrationService;
import jakarta.servlet.http.HttpSessionEvent;
import jakarta.servlet.http.HttpSessionListener;
import org.springframework.boot.web.servlet.ServletListenerRegistrationBean;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.client.ClientHttpRequestFactory;
import org.springframework.http.client.SimpleClientHttpRequestFactory;

@Configuration
public class AppConfig {

    @Bean
    public ClientHttpRequestFactory httpRequestFactory() {
        SimpleClientHttpRequestFactory factory = new SimpleClientHttpRequestFactory();
        factory.setConnectTimeout(6_000);
        factory.setReadTimeout(25_000);
        return factory;
    }

    @Bean
    public ServletListenerRegistrationBean<HttpSessionListener> sessionCleanup(MigrationService migrations,
                                                                               DemoStore demos) {
        return new ServletListenerRegistrationBean<>(new HttpSessionListener() {
            @Override
            public void sessionDestroyed(HttpSessionEvent event) {
                synchronized (event.getSession()) {
                    String id = event.getSession().getId();
                    migrations.endSession(id);
                    demos.clear(id);
                }
            }
        });
    }

    @Bean(destroyMethod = "close")
    public ExecutorService migrationExecutor() {
        return Executors.newVirtualThreadPerTaskExecutor();
    }
}
