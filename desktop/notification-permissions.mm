#import <Foundation/Foundation.h>
#import <UserNotifications/UserNotifications.h>
#include <node_api.h>
#include <memory>
#include <string>

// In-process bridge: authorization belongs to Fieldwork's bundle, not a helper.
struct Result {
  dispatch_semaphore_t done = dispatch_semaphore_create(0);
  std::string status;
  bool alerts = false;
  bool sounds = false;
  bool didRequest = false;
  bool failed = false;
};
struct Work {
  napi_async_work work;
  napi_deferred deferred;
  bool ask;
  std::string status;
  bool alerts = false;
  bool sounds = false;
  bool didRequest = false;
  bool failed = false;
};
static void Finish(UNNotificationSettings *settings, std::shared_ptr<Result> result) {
  switch (settings.authorizationStatus) {
    case UNAuthorizationStatusNotDetermined: result->status = "not-determined"; break;
    case UNAuthorizationStatusDenied: result->status = "denied"; break;
    case UNAuthorizationStatusAuthorized: result->status = "authorized"; break;
    case UNAuthorizationStatusProvisional: result->status = "provisional"; break;
    default: result->failed = true;
  }
  result->alerts = settings.alertSetting == UNNotificationSettingEnabled;
  result->sounds = settings.soundSetting == UNNotificationSettingEnabled;
  dispatch_semaphore_signal(result->done);
}
static void Execute(napi_env env, void *data) {
  auto *work = static_cast<Work *>(data);
  @autoreleasepool {
    @try {
      auto result = std::make_shared<Result>();
      const bool ask = work->ask;
      UNUserNotificationCenter *center = [UNUserNotificationCenter currentNotificationCenter];
      [center getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
        if (ask && settings.authorizationStatus == UNAuthorizationStatusNotDetermined) {
          result->didRequest = true;
          [center requestAuthorizationWithOptions:(UNAuthorizationOptionAlert | UNAuthorizationOptionSound | UNAuthorizationOptionBadge)
            completionHandler:^(BOOL granted, NSError *error) {
              if (error) {
                result->failed = true;
                dispatch_semaphore_signal(result->done);
              } else {
                [center getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *current) { Finish(current, result); }];
              }
            }];
        } else { Finish(settings, result); }
      }];
      // Wait off the JS thread. Blocks retain result after timeout, not Work.
      if (dispatch_semaphore_wait(result->done, dispatch_time(DISPATCH_TIME_NOW, 60 * NSEC_PER_SEC)) != 0) {
        work->failed = true;
      } else {
        work->failed = result->failed;
        work->status = result->status;
        work->alerts = result->alerts;
        work->sounds = result->sounds;
        work->didRequest = result->didRequest;
      }
    } @catch (NSException *exception) { work->failed = true; }
  }
}
static void Complete(napi_env env, napi_status status, void *data) {
  auto *work = static_cast<Work *>(data);
  napi_value result, value;
  if (status != napi_ok || work->failed) {
    napi_create_string_utf8(env, "macOS notification authorization unavailable.", NAPI_AUTO_LENGTH, &value);
    napi_create_error(env, nullptr, value, &result);
    napi_reject_deferred(env, work->deferred, result);
  } else {
    napi_create_object(env, &result);
    napi_create_string_utf8(env, work->status.c_str(), NAPI_AUTO_LENGTH, &value);
    napi_set_named_property(env, result, "status", value);
    napi_get_boolean(env, work->alerts, &value);
    napi_set_named_property(env, result, "alertsEnabled", value);
    napi_get_boolean(env, work->sounds, &value);
    napi_set_named_property(env, result, "soundsEnabled", value);
    napi_get_boolean(env, work->didRequest, &value);
    napi_set_named_property(env, result, "didRequest", value);
    napi_resolve_deferred(env, work->deferred, result);
  }
  napi_delete_async_work(env, work->work);
  delete work;
}
static napi_value Permission(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1], promise, name;
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  bool ask = false;
  if (argc != 1 || napi_get_value_bool(env, args[0], &ask) != napi_ok) {
    napi_throw_type_error(env, nullptr, "Expected a boolean.");
    return nullptr;
  }
  auto *work = new Work();
  work->ask = ask;
  napi_create_promise(env, &work->deferred, &promise);
  napi_create_string_utf8(env, "notificationPermission", NAPI_AUTO_LENGTH, &name);
  napi_create_async_work(env, nullptr, name, Execute, Complete, work, &work->work);
  napi_queue_async_work(env, work->work);
  return promise;
}
static napi_value Init(napi_env env, napi_value exports) {
  napi_value function;
  napi_create_function(env, "permission", NAPI_AUTO_LENGTH, Permission, nullptr, &function);
  napi_set_named_property(env, exports, "permission", function);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
