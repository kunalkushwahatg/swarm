#include <iostream>
#include <fstream>
#include <cassert>
#include <string>
#include "agent.h"

int main() {
    std::cout << "Running Swarm Milestone 10 Security Primitives Unit Tests..." << std::endl;

    using namespace swarm::security;

    // Test 1: constant_time_equals
    {
        std::cout << "Test 1: constant_time_equals..." << std::endl;
        assert(constant_time_equals("", ""));
        assert(constant_time_equals("token123", "token123"));
        assert(!constant_time_equals("token123", "token124"));
        assert(!constant_time_equals("token123", "token12"));
        assert(!constant_time_equals("token12", "token123"));
        assert(!constant_time_equals("Aoken123", "token123"));
        assert(!constant_time_equals("token123", "Token123"));
        std::cout << "  -> PASS: constant_time_equals" << std::endl;
    }

    // Test 2: extract_bearer_token
    {
        std::cout << "Test 2: extract_bearer_token..." << std::endl;
        std::string token;
        assert(extract_bearer_token("Bearer secret-token-xyz", token) && token == "secret-token-xyz");
        assert(extract_bearer_token("bearer secret-token-xyz", token) && token == "secret-token-xyz");
        assert(extract_bearer_token("Bearer    padded-token   ", token) && token == "padded-token");
        assert(!extract_bearer_token("Basic dXNlcjpwYXNz", token));
        assert(!extract_bearer_token("", token));
        assert(!extract_bearer_token("Bearer", token));
        assert(!extract_bearer_token("Bearer ", token));
        assert(!extract_bearer_token("Bearer    ", token));
        std::cout << "  -> PASS: extract_bearer_token" << std::endl;
    }

    // Test 3: is_loopback_address
    {
        std::cout << "Test 3: is_loopback_address..." << std::endl;
        assert(is_loopback_address(""));
        assert(is_loopback_address("127.0.0.1"));
        assert(is_loopback_address("127.0.1.1"));
        assert(is_loopback_address("::1"));
        assert(is_loopback_address("localhost"));
        assert(!is_loopback_address("192.168.1.10"));
        assert(!is_loopback_address("10.0.0.1"));
        assert(!is_loopback_address("172.16.0.5"));
        std::cout << "  -> PASS: is_loopback_address" << std::endl;
    }

    // Test 4: verify_telemetry_request with configured token
    {
        std::cout << "Test 4: verify_telemetry_request (configured token)..." << std::endl;
        std::string secret = "prod-swarm-token-secret-999";
        
        // Missing auth
        auto res1 = verify_telemetry_request("127.0.0.1", false, "", secret);
        assert(res1 == AuthResult::MISSING_AUTH);

        // Invalid format
        auto res2 = verify_telemetry_request("127.0.0.1", true, "Basic xyz", secret);
        assert(res2 == AuthResult::INVALID_FORMAT);

        // Invalid token
        auto res3 = verify_telemetry_request("127.0.0.1", true, "Bearer wrong-token", secret);
        assert(res3 == AuthResult::INVALID_TOKEN);

        // Valid token
        auto res4 = verify_telemetry_request("127.0.0.1", true, "Bearer " + secret, secret);
        assert(res4 == AuthResult::OK);

        // Valid token from remote address
        auto res5 = verify_telemetry_request("10.10.10.2", true, "Bearer " + secret, secret);
        assert(res5 == AuthResult::OK);
        std::cout << "  -> PASS: verify_telemetry_request (configured token)" << std::endl;
    }

    // Test 5: verify_telemetry_request with unconfigured token (development mode)
    {
        std::cout << "Test 5: verify_telemetry_request (unconfigured token / dev mode)..." << std::endl;
        // Loopback should pass
        auto res1 = verify_telemetry_request("127.0.0.1", false, "", "");
        assert(res1 == AuthResult::OK);

        // Remote address without configured token should be rejected with 403
        auto res2 = verify_telemetry_request("192.168.1.55", false, "", "");
        assert(res2 == AuthResult::REMOTE_UNAUTHENTICATED_FORBIDDEN);

        auto res3 = verify_telemetry_request("10.0.0.5", false, "", "");
        assert(res3 == AuthResult::REMOTE_UNAUTHENTICATED_FORBIDDEN);
        std::cout << "  -> PASS: verify_telemetry_request (dev mode)" << std::endl;
    }

    // Test 6: read_secret_from_file (Milestone 11)
    {
        std::cout << "Test 6: read_secret_from_file..." << std::endl;
        std::string test_path = "test_temp_token.txt";
        {
            std::ofstream out(test_path);
            out << "   my-super-secret-token-from-file-2026   \n";
        }

        std::string loaded;
        assert(read_secret_from_file(test_path, loaded));
        assert(loaded == "my-super-secret-token-from-file-2026");

        // Non-existent file
        std::string dummy;
        assert(!read_secret_from_file("non_existent_file_xyz_123.txt", dummy));

        // Clean up
        std::remove(test_path.c_str());
        std::cout << "  -> PASS: read_secret_from_file" << std::endl;
    }

    std::cout << "\nALL 6 SECURITY UNIT TESTS PASSED SUCCESSFULLY!" << std::endl;
    return 0;
}

