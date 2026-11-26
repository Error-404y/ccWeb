qzu_java21() {
  local candidate version brew_path
  brew_path=""
  if command -v brew >/dev/null 2>&1; then
    brew_path="$(brew --prefix openjdk@21 2>/dev/null || true)"
  fi
  for candidate in "${QZU_JAVA_HOME:-}" "${JAVA_HOME:-}" "$(/usr/libexec/java_home -F -v 21 2>/dev/null || true)" "${brew_path:+$brew_path/libexec/openjdk.jdk/Contents/Home}" "/Applications/Android Studio.app/Contents/jbr/Contents/Home"; do
    [[ -n "$candidate" && -x "$candidate/bin/java" && -x "$candidate/bin/javac" ]] || continue
    version="$("$candidate/bin/java" -version 2>&1 | awk -F'"' 'NR==1 {print $2}')"
    case "$version" in
      21|21.*|21-*)
        export JAVA_HOME="$candidate"
        export PATH="$JAVA_HOME/bin:$PATH"
        echo "Using Java $version at $JAVA_HOME"
        return 0
        ;;
    esac
  done
  echo "Java 21 JDK required. Install it using: brew install openjdk@21" >&2
  return 1
}
