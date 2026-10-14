import urllib.request, json
data = json.dumps({
    "messages": [{"role": "user", "content": "Write a short 3 paragraph essay about outer space exploration and astronomy."}],
    "max_tokens": 200
}).encode()
req = urllib.request.Request(
    "http://localhost:8080/v1/chat/completions",
    data=data,
    headers={"Content-Type": "application/json"},
    method="POST"
)
try:
    resp = urllib.request.urlopen(req, timeout=120)
    for line in resp:
        print(line.decode(), end="")
except Exception as e:
    print("Error:", e)
