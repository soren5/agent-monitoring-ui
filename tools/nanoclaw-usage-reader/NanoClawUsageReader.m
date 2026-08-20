#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>

static id attribute(AXUIElementRef element, CFStringRef name) {
  CFTypeRef value = NULL;
  if (AXUIElementCopyAttributeValue(element, name, &value) != kAXErrorSuccess) return nil;
  return CFBridgingRelease(value);
}

static void emit(NSDictionary *object, int status) {
  NSData *json = [NSJSONSerialization dataWithJSONObject:object options:NSJSONWritingSortedKeys error:nil];
  NSFileHandle *out = [NSFileHandle fileHandleWithStandardOutput];
  [out writeData:json];
  [out writeData:[@"\n" dataUsingEncoding:NSUTF8StringEncoding]];
  exit(status);
}

static NSArray<NSString *> *usageLines(AXUIElementRef root) {
  NSArray *terms = @[ @"token", @"usage", @"limit", @"remaining", @"reset", @"hour", @"week", @"day", @"credit" ];
  NSMutableArray *pending = [NSMutableArray arrayWithObject:(__bridge id)root];
  NSMutableOrderedSet<NSString *> *lines = [NSMutableOrderedSet orderedSet];
  while (pending.count) {
    AXUIElementRef current = (__bridge AXUIElementRef)pending.lastObject;
    [pending removeLastObject];
    id children = attribute(current, kAXChildrenAttribute);
    if ([children isKindOfClass:[NSArray class]]) [pending addObjectsFromArray:children];
    for (NSString *field in @[ (__bridge NSString *)kAXValueAttribute, (__bridge NSString *)kAXTitleAttribute, (__bridge NSString *)kAXDescriptionAttribute ]) {
      id value = attribute(current, (__bridge CFStringRef)field);
      if (![value isKindOfClass:[NSString class]]) continue;
      NSString *text = [(NSString *)value stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
      if (!text.length) continue;
      NSString *lower = text.lowercaseString;
      if ([terms indexOfObjectPassingTest:^BOOL(NSString *term, NSUInteger _, BOOL *__) { return [lower containsString:term]; }] != NSNotFound) {
        [lines addObject:text];
      }
    }
  }
  return lines.array;
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    NSString *action = argc == 1 ? @"read-usage" : [NSString stringWithUTF8String:argv[1]];
    if (![action isEqualToString:@"read-usage"] && ![action isEqualToString:@"--request-accessibility"]) {
      emit(@{ @"ok": @NO, @"error": @"Unsupported action. Only read-usage is available." }, 64);
    }
    if ([action isEqualToString:@"--request-accessibility"]) {
      BOOL trusted = AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)@{ (__bridge id)kAXTrustedCheckOptionPrompt: @YES });
      emit(@{ @"ok": @(trusted), @"action": @"accessibility-requested" }, trusted ? 0 : 2);
    }
    if (!AXIsProcessTrusted()) emit(@{ @"ok": @NO, @"error": @"Accessibility permission is required for NanoClawUsageReader.app" }, 2);
    NSRunningApplication *chatGPT = nil;
    for (NSRunningApplication *app in NSWorkspace.sharedWorkspace.runningApplications) {
      if ([app.bundleIdentifier isEqualToString:@"com.openai.chat"] || [app.localizedName isEqualToString:@"ChatGPT"]) { chatGPT = app; break; }
    }
    if (!chatGPT) emit(@{ @"ok": @NO, @"error": @"ChatGPT is not running" }, 3);
    AXUIElementRef app = AXUIElementCreateApplication(chatGPT.processIdentifier);
    NSArray *windows = attribute(app, kAXWindowsAttribute);
    AXUIElementRef usage = NULL;
    for (id window in windows ?: @[]) {
      NSString *title = attribute((__bridge AXUIElementRef)window, kAXTitleAttribute);
      if ([title rangeOfString:@"usage" options:NSCaseInsensitiveSearch].location != NSNotFound) { usage = (__bridge AXUIElementRef)window; break; }
    }
    if (!usage) emit(@{ @"ok": @NO, @"error": @"Open the ChatGPT/Codex Usage view, then retry" }, 4);
    NSArray *lines = usageLines(usage);
    if (!lines.count) emit(@{ @"ok": @NO, @"error": @"The visible Usage window did not expose readable usage values" }, 5);
    NSString *title = attribute(usage, kAXTitleAttribute) ?: @"Usage";
    emit(@{ @"ok": @YES, @"source": @"ChatGPT Usage view", @"windowTitle": title, @"lines": lines }, 0);
  }
}
