#include "config.h"
#include <iostream>

int main() {
    SwarmConfig config = load_config_from_env();
    std::cout << "Model path: " << config.model_path << std::endl;
    std::cout << "HTTP bind: " << config.http_bind_address << std::endl;
    std::cout << "HTTP port: " << config.http_port << std::endl;
    std::cout << "RPC enabled: " << (config.rpc_enabled ? "true" : "false") << std::endl;
    std::cout << "RPC endpoint: " << config.rpc_endpoint << std::endl;
    std::cout << "Context size: " << config.ctx_size << std::endl;
    std::cout << "Default max tokens: " << config.max_tokens_default << std::endl;
    std::cout << "Log timestamps: " << (config.log_timestamps ? "true" : "false") << std::endl;
    return 0;
}