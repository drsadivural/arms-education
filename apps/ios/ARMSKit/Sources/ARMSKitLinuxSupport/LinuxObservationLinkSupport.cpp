// Linux-only: provides `swift::threading::fatal`, which some Linux distributions of
// libswiftObservation.so reference without exporting. Semantics match the runtime's own
// implementation (report and abort). Not compiled into the iOS app.
#if defined(__linux__)
#include <cstdarg>
#include <cstdio>
#include <cstdlib>

namespace swift {
namespace threading {
[[noreturn]] void fatal(const char *msg, ...) {
  va_list args;
  va_start(args, msg);
  std::vfprintf(stderr, msg, args);
  va_end(args);
  std::abort();
}
} // namespace threading
} // namespace swift
#endif
