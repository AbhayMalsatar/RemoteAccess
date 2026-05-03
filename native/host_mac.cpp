// Chrome Native Messaging host for macOS — mouse + keyboard via CoreGraphics.
//
// Build (from repo root):
//   ./native/build_mac.sh
//
// Install manifest JSON at:
//   ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.remote.control.json
// Contents: copy native/manifest.json, set "path" to absolute path of host-macos binary,
// and set allowed_origins to your chrome-extension://<id>/
//
// Grant Accessibility: System Settings → Privacy & Security → Accessibility
// — enable for Terminal (if you run from terminal) or for host-macos if you wrap it in an app.

#include <ApplicationServices/ApplicationServices.h>
#include <Carbon/Carbon.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <string>
#include <vector>

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
  if (length > 32 * 1024 * 1024) {
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

CGRect VirtualScreenFrame() {
  constexpr CGDisplayCount kMax = 32;
  CGDirectDisplayID displays[kMax];
  CGDisplayCount count = 0;
  if (CGGetOnlineDisplayList(kMax, displays, &count) != kCGErrorSuccess || count == 0) {
    return CGDisplayBounds(CGMainDisplayID());
  }
  CGRect unionRect = CGRectNull;
  for (CGDisplayCount i = 0; i < count; ++i) {
    CGRect b = CGDisplayBounds(displays[i]);
    unionRect = CGRectIsNull(unionRect) ? b : CGRectUnion(unionRect, b);
  }
  return CGRectIsNull(unionRect) ? CGDisplayBounds(CGMainDisplayID()) : unionRect;
}

bool ExtractDoubleField(const std::string& input, const std::string& key, double& value) {
  const std::string token = "\"" + key + "\":";
  const std::size_t start = input.find(token);
  if (start == std::string::npos) {
    return false;
  }
  std::size_t i = start + token.size();
  while (i < input.size() && (input[i] == ' ' || input[i] == '\t')) {
    ++i;
  }
  if (i >= input.size()) {
    return false;
  }
  char* end = nullptr;
  const char* cstr = input.c_str() + i;
  value = std::strtod(cstr, &end);
  return end != cstr;
}

bool ExtractIntField(const std::string& input, const std::string& key, int& value) {
  double d = 0;
  if (!ExtractDoubleField(input, key, d)) {
    return false;
  }
  value = static_cast<int>(std::lround(d));
  return true;
}

bool ExtractJsonString(const std::string& input, const std::string& key, std::string& out) {
  const std::string token = "\"" + key + "\":\"";
  const std::size_t start = input.find(token);
  if (start == std::string::npos) {
    return false;
  }
  std::size_t i = start + token.size();
  std::string s;
  while (i < input.size()) {
    char c = input[i];
    if (c == '\\' && i + 1 < input.size()) {
      s.push_back(input[i + 1]);
      i += 2;
      continue;
    }
    if (c == '"') {
      break;
    }
    s.push_back(c);
    ++i;
  }
  out = std::move(s);
  return true;
}

void PostMouseMoved(CGFloat x, CGFloat y) {
  CGPoint p = CGPointMake(x, y);
  CGEventRef ev = CGEventCreateMouseEvent(nullptr, kCGEventMouseMoved, p, kCGMouseButtonLeft);
  if (!ev) {
    return;
  }
  CGEventPost(kCGHIDEventTap, ev);
  CFRelease(ev);
}

void PostLeftClick(CGFloat x, CGFloat y) {
  CGPoint p = CGPointMake(x, y);
  CGEventRef down =
      CGEventCreateMouseEvent(nullptr, kCGEventLeftMouseDown, p, kCGMouseButtonLeft);
  CGEventRef up = CGEventCreateMouseEvent(nullptr, kCGEventLeftMouseUp, p, kCGMouseButtonLeft);
  if (down && up) {
    CGEventPost(kCGHIDEventTap, down);
    CGEventPost(kCGHIDEventTap, up);
  }
  if (down) {
    CFRelease(down);
  }
  if (up) {
    CFRelease(up);
  }
}

void MoveFromNormalized(double nx, double ny) {
  nx = std::max(0.0, std::min(1.0, nx));
  ny = std::max(0.0, std::min(1.0, ny));
  CGRect frame = VirtualScreenFrame();
  CGFloat x = frame.origin.x + static_cast<CGFloat>(nx) * frame.size.width;
  CGFloat y = frame.origin.y + static_cast<CGFloat>(ny) * frame.size.height;
  PostMouseMoved(x, y);
}

void ClickFromNormalized(double nx, double ny) {
  nx = std::max(0.0, std::min(1.0, nx));
  ny = std::max(0.0, std::min(1.0, ny));
  CGRect frame = VirtualScreenFrame();
  CGFloat x = frame.origin.x + static_cast<CGFloat>(nx) * frame.size.width;
  CGFloat y = frame.origin.y + static_cast<CGFloat>(ny) * frame.size.height;
  PostLeftClick(x, y);
}

void PostScrollPixels(double dx, double dy) {
  int32_t ix = static_cast<int32_t>(std::lround(dx));
  int32_t iy = static_cast<int32_t>(std::lround(dy));
  if (ix == 0 && iy == 0) {
    return;
  }
  CGEventRef ev =
      CGEventCreateScrollWheelEvent(nullptr, kCGScrollEventUnitPixel, 2, iy, ix);
  if (!ev) {
    return;
  }
  CGEventPost(kCGHIDEventTap, ev);
  CFRelease(ev);
}

void MoveFromPixelCoords(int x, int y) {
  PostMouseMoved(static_cast<CGFloat>(x), static_cast<CGFloat>(y));
}

bool PostKeyCode(CGKeyCode keyCode, bool keyDown) {
  CGEventRef ev = CGEventCreateKeyboardEvent(nullptr, keyCode, keyDown);
  if (!ev) {
    return false;
  }
  CGEventPost(kCGHIDEventTap, ev);
  CFRelease(ev);
  return true;
}

void PostUnicodeChar(const std::string& ch) {
  if (ch.empty()) {
    return;
  }
  UniChar u = static_cast<UniChar>(static_cast<unsigned char>(ch[0]));
  CGEventRef ev = CGEventCreateKeyboardEvent(nullptr, 0, true);
  if (!ev) {
    return;
  }
  CGEventKeyboardSetUnicodeString(ev, 1, &u);
  CGEventPost(kCGHIDEventTap, ev);
  CGEventRef up = CGEventCreateKeyboardEvent(nullptr, 0, false);
  if (up) {
    CGEventPost(kCGHIDEventTap, up);
    CFRelease(up);
  }
  CFRelease(ev);
}

CGKeyCode KeyNameToVK(const std::string& k) {
  if (k == "Enter" || k == "Return") {
    return kVK_Return;
  }
  if (k == "Escape" || k == "Esc") {
    return kVK_Escape;
  }
  if (k == "Backspace" || k == "Delete") {
    return kVK_Delete;
  }
  if (k == "Tab") {
    return kVK_Tab;
  }
  if (k == " ") {
    return kVK_Space;
  }
  if (k == "ArrowLeft") {
    return kVK_LeftArrow;
  }
  if (k == "ArrowRight") {
    return kVK_RightArrow;
  }
  if (k == "ArrowUp") {
    return kVK_UpArrow;
  }
  if (k == "ArrowDown") {
    return kVK_DownArrow;
  }
  if (k == "Home") {
    return kVK_Home;
  }
  if (k == "End") {
    return kVK_End;
  }
  if (k == "PageUp") {
    return kVK_PageUp;
  }
  if (k == "PageDown") {
    return kVK_PageDown;
  }
  return 0xFF;
}

void HandleKey(const std::string& keyStr) {
  if (keyStr.empty()) {
    return;
  }
  CGKeyCode vk = KeyNameToVK(keyStr);
  if (vk != 0xFF) {
    PostKeyCode(vk, true);
    PostKeyCode(vk, false);
    return;
  }
  if (keyStr.size() == 1) {
    PostUnicodeChar(keyStr);
    return;
  }
}

}  // namespace

int main() {
  std::string message;
  while (ReadNativeMessage(message)) {
    if (message.find("\"type\":\"move\"") != std::string::npos) {
      double nx = 0;
      double ny = 0;
      if (ExtractDoubleField(message, "nx", nx) && ExtractDoubleField(message, "ny", ny)) {
        MoveFromNormalized(nx, ny);
      } else {
        int x = 0;
        int y = 0;
        if (ExtractIntField(message, "x", x) && ExtractIntField(message, "y", y)) {
          MoveFromPixelCoords(x, y);
        }
      }
      WriteNativeMessage("{\"ok\":true,\"type\":\"move\"}");
      continue;
    }

    if (message.find("\"type\":\"wheel\"") != std::string::npos) {
      double dx = 0;
      double dy = 0;
      ExtractDoubleField(message, "deltaX", dx);
      ExtractDoubleField(message, "deltaY", dy);
      PostScrollPixels(dx, dy);
      WriteNativeMessage("{\"ok\":true,\"type\":\"wheel\"}");
      continue;
    }

    if (message.find("\"type\":\"wheel\"") != std::string::npos) {
      double dx = 0;
      double dy = 0;
      ExtractDoubleField(message, "deltaX", dx);
      ExtractDoubleField(message, "deltaY", dy);
      PostScrollPixels(dx, dy);
      WriteNativeMessage("{\"ok\":true,\"type\":\"wheel\"}");
      continue;
    }

    if (message.find("\"type\":\"click\"") != std::string::npos) {
      double nx = 0;
      double ny = 0;
      if (ExtractDoubleField(message, "nx", nx) && ExtractDoubleField(message, "ny", ny)) {
        ClickFromNormalized(nx, ny);
      } else {
        int x = 0;
        int y = 0;
        if (ExtractIntField(message, "x", x) && ExtractIntField(message, "y", y)) {
          PostLeftClick(static_cast<CGFloat>(x), static_cast<CGFloat>(y));
        } else {
          CGEventRef loc = CGEventCreate(nullptr);
          if (loc) {
            CGPoint cur = CGEventGetLocation(loc);
            PostLeftClick(cur.x, cur.y);
            CFRelease(loc);
          }
        }
      }
      WriteNativeMessage("{\"ok\":true,\"type\":\"click\"}");
      continue;
    }

    if (message.find("\"type\":\"key\"") != std::string::npos) {
      std::string keyStr;
      if (ExtractJsonString(message, "key", keyStr)) {
        HandleKey(keyStr);
      }
      WriteNativeMessage("{\"ok\":true,\"type\":\"key\"}");
      continue;
    }

    WriteNativeMessage("{\"ok\":false,\"error\":\"unknown message\"}");
  }
  return 0;
}
