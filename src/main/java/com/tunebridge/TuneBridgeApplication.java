package com.tunebridge;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;

@SpringBootApplication
@ConfigurationPropertiesScan
public class TuneBridgeApplication {

    public static void main(String[] args) {
        SpringApplication.run(TuneBridgeApplication.class, args);
    }
}
