cmake_minimum_required(VERSION 3.14)
project(SwarmNode C CXX)

# Require C++17
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# 1. Add the llama.cpp folder as a subdirectory so CMake builds it
add_subdirectory(llama.cpp)

# 2. Create your executable from your main.cpp file
add_executable(swarm_node
	main.cpp
	worker.cpp
	inference_engine.cpp
	coordinator_http.cpp
	metrics_collector.cpp
	rpc_telemetry.cpp
	llama.cpp/vendor/cpp-httplib/httplib.cpp
)

# 3. Link the application to llama.cpp and its RPC backend
target_include_directories(swarm_node PRIVATE
	llama.cpp/vendor/cpp-httplib
	llama.cpp/vendor/nlohmann
)
target_link_libraries(swarm_node PRIVATE llama ggml-rpc)
if (WIN32)
	target_link_libraries(swarm_node PRIVATE ws2_32)
endif()

# 4. Worker Resource Reporting Agent (Milestone 8)
add_executable(swarm_agent
	agent_main.cpp
	llama.cpp/vendor/cpp-httplib/httplib.cpp
)
target_include_directories(swarm_agent PRIVATE
	llama.cpp/vendor/cpp-httplib
	llama.cpp/vendor/nlohmann
)
if (WIN32)
	target_link_libraries(swarm_agent PRIVATE ws2_32 crypt32 dxgi)
endif()

# 5. Security Unit Tests (Milestone 10)
add_executable(test_security
	test_security.cpp
)
target_include_directories(test_security PRIVATE
	llama.cpp/vendor/nlohmann
)
if (WIN32)
	target_link_libraries(test_security PRIVATE ws2_32 crypt32 dxgi)
endif()

# 6. Remote RPC Health & Placement Tests (Milestone 12)
add_executable(test_rpc_health
	test_rpc_health.cpp
	worker.cpp
)
target_include_directories(test_rpc_health PRIVATE
	llama.cpp/vendor/nlohmann
	llama.cpp/ggml/include
)
if (WIN32)
	target_link_libraries(test_rpc_health PRIVATE ws2_32 iphlpapi)
endif()

# 7. Placement Policy Tests
add_executable(test_policy test_policy.cpp)

# 8. Dynamic Resource Policy Tests
add_executable(test_dynamic_policy test_dynamic_policy.cpp)
target_include_directories(test_dynamic_policy PRIVATE
	llama.cpp/vendor/nlohmann
	llama.cpp/ggml/include
)

# 9. Node Inventory Tests
add_executable(test_node_inventory test_node_inventory.cpp)
target_include_directories(test_node_inventory PRIVATE
	llama.cpp/vendor/nlohmann
	llama.cpp/ggml/include
)

# 10. Agent & Inventory Integration Tests
add_executable(test_agent_and_inventory test_agent_and_inventory.cpp)
target_include_directories(test_agent_and_inventory PRIVATE
	llama.cpp/vendor/nlohmann
	llama.cpp/ggml/include
)
if (WIN32)
	target_link_libraries(test_agent_and_inventory PRIVATE ws2_32 crypt32 dxgi)
endif()

# The unit tests use assert() for validation, including calls whose side
# effects are part of the test (e.g. ingest_agent_report). Release builds set
# NDEBUG, which turns every assert into a no-op and silently skips those calls.
# Keep assertions active for test targets regardless of build type.
set(SWARM_TEST_TARGETS
	test_security
	test_rpc_health
	test_policy
	test_dynamic_policy
	test_node_inventory
	test_agent_and_inventory
)
foreach(_test_target IN LISTS SWARM_TEST_TARGETS)
	if (MSVC)
		target_compile_options(${_test_target} PRIVATE /UNDEBUG)
	else()
		target_compile_options(${_test_target} PRIVATE -UNDEBUG)
	endif()
endforeach()



