#pragma once

#include <string>
#include <iostream>
#include <chrono>
#include <ctime>

namespace swarm {

inline std::string get_timestamp(bool include_ms = true) {
    auto now = std::chrono::system_clock::now();
    auto time_t = std::chrono::system_clock::to_time_t(now);
    std::tm tm{};
#ifdef _WIN32
    localtime_s(&tm, &time_t);
#else
    localtime_r(&time_t, &tm);
#endif

    char buffer[80];
    strftime(buffer, sizeof(buffer), "%Y-%m-%d %H:%M:%S", &tm);

    if (include_ms) {
        auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
            now.time_since_epoch()) % 1000;
        char result[100];
        snprintf(result, sizeof(result), "%s.%03lld", buffer, static_cast<long long>(ms.count()));
        return std::string(result);
    }

    return std::string(buffer);
}

inline void log_info(const std::string& message, bool include_timestamp = true) {
    if (include_timestamp) {
        std::cout << "[" << get_timestamp() << "] INFO: " << message << std::endl;
    } else {
        std::cout << "INFO: " << message << std::endl;
    }
}

inline void log_warn(const std::string& message, bool include_timestamp = true) {
    if (include_timestamp) {
        std::cout << "[" << get_timestamp() << "] WARN: " << message << std::endl;
    } else {
        std::cout << "WARN: " << message << std::endl;
    }
}

inline void log_error(const std::string& message, bool include_timestamp = true) {
    if (include_timestamp) {
        std::cerr << "[" << get_timestamp() << "] ERROR: " << message << std::endl;
    } else {
        std::cerr << "ERROR: " << message << std::endl;
    }
}

} // namespace swarm
