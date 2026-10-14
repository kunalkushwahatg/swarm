#include "placement.h"
#include <iostream>
#include <cassert>

int main() {
    PlacementTracker tracker;

    // Register test backends
    tracker.register_backend("RPC0", "RPC0", "127.0.0.1:50052", "127.0.0.1:50052",
                             "loopback_rpc", true, "shared_host", 8418131968ULL, 1739460608ULL);
    tracker.register_backend("RPC1", "RPC1", "127.0.0.1:50053", "127.0.0.1:50053",
                             "loopback_rpc", true, "shared_host", 8418131968ULL, 1739460608ULL);
    tracker.register_backend("CUDA0", "CUDA0", "NVIDIA GeForce GTX 1050", "",
                             "local_cuda", false, "device_vram", 4294967296ULL, 3526361088ULL);
    tracker.register_backend("CPU", "CPU", "Host CPU", "",
                             "cpu", false, "shared_host", 17179869184ULL, 8589934592ULL);

    // Parse the preserved clean-swarm log
    std::string log_path = "artifacts/validation/2026-10-10/multi-rpc/clean-swarm.stderr.log";
    bool ok = tracker.parse_log_file(log_path);
    if (!ok) {
        std::cerr << "Failed to open " << log_path << std::endl;
        return 1;
    }

    auto rpc0 = tracker.get_backend("RPC0");
    auto rpc1 = tracker.get_backend("RPC1");
    auto cuda0 = tracker.get_backend("CUDA0");
    auto cpu = tracker.get_backend("CPU");

    assert(rpc0.has_value());
    assert(rpc1.has_value());
    assert(cuda0.has_value());
    assert(cpu.has_value());

    std::cout << "RPC0 assigned layers count: " << rpc0->assigned_layers.size() << std::endl;
    std::cout << "RPC0 model buffer bytes: " << rpc0->model_buffer_bytes << std::endl;
    std::cout << "RPC0 kv buffer bytes: " << rpc0->kv_buffer_bytes << std::endl;
    std::cout << "RPC0 compute buffer bytes: " << rpc0->compute_buffer_bytes << std::endl;

    std::cout << "RPC1 assigned layers count: " << rpc1->assigned_layers.size() << std::endl;
    std::cout << "RPC1 model buffer bytes: " << rpc1->model_buffer_bytes << std::endl;
    std::cout << "RPC1 kv buffer bytes: " << rpc1->kv_buffer_bytes << std::endl;
    std::cout << "RPC1 compute buffer bytes: " << rpc1->compute_buffer_bytes << std::endl;

    std::cout << "CUDA0 assigned layers count: " << cuda0->assigned_layers.size() << std::endl;
    std::cout << "CUDA0 model buffer bytes: " << cuda0->model_buffer_bytes << std::endl;
    std::cout << "CUDA0 kv buffer bytes: " << cuda0->kv_buffer_bytes << std::endl;
    std::cout << "CUDA0 compute buffer bytes: " << cuda0->compute_buffer_bytes << std::endl;

    std::cout << "CPU assigned layers count: " << cpu->assigned_layers.size() << std::endl;

    // Verify expected layer assignments
    assert(rpc0->assigned_layers.size() == 1 && rpc0->assigned_layers[0] == 33);
    assert(rpc1->assigned_layers.size() == 1 && rpc1->assigned_layers[0] == 34);
    assert(cuda0->assigned_layers.size() == 2 && cuda0->assigned_layers[0] == 35 && cuda0->assigned_layers[1] == 36);
    assert(cpu->assigned_layers.size() == 33);

    // Verify ranges
    assert(rpc0->assigned_layer_ranges.size() == 1);
    assert(rpc0->assigned_layer_ranges[0].first == 33 && rpc0->assigned_layer_ranges[0].second == 33);
    assert(cuda0->assigned_layer_ranges.size() == 1);
    assert(cuda0->assigned_layer_ranges[0].first == 35 && cuda0->assigned_layer_ranges[0].second == 36);
    assert(cpu->assigned_layer_ranges.size() == 1);
    assert(cpu->assigned_layer_ranges[0].first == 0 && cpu->assigned_layer_ranges[0].second == 32);

    // Verify buffers (47.04 MiB ~ 49325056)
    assert(rpc0->model_buffer_bytes > 40000000);
    assert(rpc1->model_buffer_bytes > 40000000);
    assert(cuda0->model_buffer_bytes > 200000000);

    json j = tracker.to_json(17179869184ULL, 8589934592ULL);
    std::cout << "Placement JSON:\n" << j.dump(2) << std::endl;

    std::cout << "ALL TESTS PASSED!" << std::endl;
    return 0;
}
