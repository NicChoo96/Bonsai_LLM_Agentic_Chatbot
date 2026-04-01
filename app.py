import requests

response = requests.post(
    "http://localhost:8080/v1/chat/completions",
    json={
        "messages": [
            {"role": "system", "content": "You are a helpful assistant."},
            {"role": "user", "content": "Hello! What can you do?"}
        ]
    }
)
print(response.json()['choices'][0]['message']['content'])