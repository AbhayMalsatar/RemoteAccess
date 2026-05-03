#include <cstdint>
#include <iostream>
#include <string>
#include <vector>

#ifdef _WIN32
#include <windows.h>
#endif

namespace {

bool ReadExact(std::istream& in, char* buffer, std::size_t size) {
  in.read(buffer, static_cast<std::streamsize>(size));
  return static_cast<std::size_t>(in.gcount()) == size;
}

bool ReadNativeMessage(std::string& out) {
  std::uint32_t length = 0;
  if (!ReadExact(std::cin, reinterpret_cast<char*>(&length), sizeof(length))) {
    return false;
  }

  std::vector<char> payload(length);
  if (length > 0 && !ReadExact(std::cin, payload.data(), payload.size())) {
    return false;
  }

  out.assign(payload.begin(), payload.end());
  return true;
}

void WriteNativeMessage(const std::string& message) {
  std::uint32_t length = static_cast<std::uint32_t>(message.size());
  std::cout.write(reinterpret_cast<const char*>(&length), sizeof(length));
  std::cout.write(message.data(), static_cast<std::streamsize>(message.size()));
  std::cout.flush();
}

bool ExtractIntField(const std::string& input, const std::string& key, int& value) {
  const std::string token = "\"" + key + "\":";
  const std::size_t start = input.find(token);
  if (start == std::string::npos) {
    return false;
  }

  std::size_t i = start + token.size();
  bool negative = false;
  if (i < input.size() && input[i] == '-') {
    negative = true;
    ++i;
  }
  if (i >= input.size() || input[i] < '0' || input[i] > '9') {
    return false;
  }

  long parsed = 0;
  while (i < input.size() && input[i] >= '0' && input[i] <= '9') {
    parsed = parsed * 10 + (input[i] - '0');
    ++i;
  }

  value = static_cast<int>(negative ? -parsed : parsed);
  return true;
}

#ifdef _WIN32
void MoveMouse(int x, int y) {
  SetCursorPos(x, y);
}

void ClickLeftMouse() {
  mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0);
  mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
}
#endif

}  // namespace

int main() {
  std::string message;

  while (ReadNativeMessage(message)) {
    // TODO: Replace naive checks with strict JSON parsing.
    if (message.find("\"type\":\"move\"") != std::string::npos) {
#ifdef _WIN32
      int x = 0;
      int y = 0;
      if (ExtractIntField(message, "x", x) && ExtractIntField(message, "y", y)) {
        MoveMouse(x, y);
      }
#endif
      WriteNativeMessage("{\"ok\":true,\"type\":\"move\"}");
      continue;
    }

    if (message.find("\"type\":\"click\"") != std::string::npos) {
#ifdef _WIN32
      ClickLeftMouse();
#endif
      WriteNativeMessage("{\"ok\":true,\"type\":\"click\"}");
      continue;
    }

    WriteNativeMessage("{\"ok\":false,\"error\":\"unknown message\"}");
  }

  return 0;
}
