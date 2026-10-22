<h2 id="observation-details">Observation details</h2>
<p>
  Observation is read-only and available while wm is paused. <code>window</code> contains fresh
  window facts with committed workspace membership; <code>cachedWindow</code> contains the engine's
  earlier observation. Reading a window does not replace cached state. Diagnostics are included
  without <code>--verbose</code>.
</p>

<h2 id="macos-details">Platform-specific details: macOS</h2>
<p>
  Queries run in wm's native permission context. Each query reports its scope, attribute, numeric
  error code, readable error name, value type, and value. Failed reads have a null value; unsupported
  attributes are not interpreted as false. Sequential reads are a best-effort inspection, not an
  atomic snapshot.
</p>
<p>
  Use <code>wm window observe --pid 65900</code> to inspect an application's windows even when a
  minimized window is absent from wm's inventory. Use a current process ID, and choose either
  <code>--pid</code> or <code>--window</code>. PID observation returns null for <code>window</code> and
  <code>cachedWindow</code>; its evidence is in <code>diagnostics</code>.
</p>
<table>
  <thead><tr><th>Data</th><th>Apple API</th></tr></thead>
  <tbody>
    <tr>
      <td>Raw application windows</td>
      <td>
        <a href="https://developer.apple.com/documentation/applicationservices/1459374-axuielementcreateapplication">AXUIElementCreateApplication</a>
        and <a href="https://developer.apple.com/documentation/applicationservices/kaxwindowsattribute">AXWindows</a>.
        The application query value is the returned count; <code>diagnostics.rawWindows</code> holds
        each element's index, PID query status, target match, and window queries before inventory filtering.
      </td>
    </tr>
    <tr>
      <td>Window attributes and raw errors</td>
      <td>
        <a href="https://developer.apple.com/documentation/applicationservices/1462085-axuielementcopyattributevalue">AXUIElementCopyAttributeValue</a>
        reads the <a href="https://developer.apple.com/documentation/applicationservices/axattributeconstants_h">Accessibility attributes</a>.
        Raw windows remain visible even when individual geometry or state queries fail. Their indexes
        are positions in this response, not stable window IDs; native pointers and UI text contents are omitted.
      </td>
    </tr>
    <tr>
      <td>Minimized state and restoration capability</td>
      <td>
        <a href="https://developer.apple.com/documentation/applicationservices/kaxminimizedattribute">AXMinimized</a>
        reports minimized state. <code>AXMinimized.settable</code> comes from
        <a href="https://developer.apple.com/documentation/applicationservices/1459972-axuielementisattributesettable">AXUIElementIsAttributeSettable</a>,
        as do position and size settable checks. A successful true result means the app reports that
        the attribute can be changed. Setting it to false with
        <a href="https://developer.apple.com/documentation/applicationservices/1460434-axuielementsetattributevalue">AXUIElementSetAttributeValue</a>
        requests restoration from the Dock; observe does not perform that write or verify restoration.
      </td>
    </tr>
    <tr>
      <td>Local, application, and global focus</td>
      <td>
        Window <a href="https://developer.apple.com/documentation/applicationservices/kaxfocusedattribute">AXFocused</a>
        and AXMain are separate from application
        <a href="https://developer.apple.com/documentation/applicationservices/kaxfrontmostattribute">AXFrontmost</a>
        and <a href="https://developer.apple.com/documentation/applicationservices/kaxfocusedwindowattribute">AXFocusedWindow</a>.
        <a href="https://developer.apple.com/documentation/applicationservices/1462095-axuielementcreatesystemwide">AXUIElementCreateSystemWide</a>
        supplies <a href="https://developer.apple.com/documentation/applicationservices/kaxfocusedapplicationattribute">AXFocusedApplication</a>
        and <a href="https://developer.apple.com/documentation/applicationservices/kaxfocuseduielementattribute">AXFocusedUIElement</a>.
        Element PID and target-match facts do not imply that an inactive app has global focus.
      </td>
    </tr>
    <tr>
      <td>Application registration and foreground PID</td>
      <td>
        <a href="https://developer.apple.com/documentation/appkit/nsrunningapplication">NSRunningApplication</a>
        supplies registration, activation policy, active, and hidden facts.
        <a href="https://developer.apple.com/documentation/appkit/nsworkspace/frontmostapplication">NSWorkspace.frontmostApplication</a>
        is sampled before and after the diagnostic queries. A missing window target without a PID
        cannot establish whether its application is registered; use PID observation for that check.
      </td>
    </tr>
    <tr>
      <td>Element identity and observer permissions</td>
      <td>
        <a href="https://developer.apple.com/documentation/applicationservices/1460337-axuielementgetpid">AXUIElementGetPid</a>
        supplies element PID and its query status. Observer grants come from
        <a href="https://developer.apple.com/documentation/applicationservices/1460720-axisprocesstrusted">AXIsProcessTrusted</a>
        and <a href="https://developer.apple.com/documentation/coregraphics/cgpreflightscreencaptureaccess()">CGPreflightScreenCaptureAccess</a>.
      </td>
    </tr>
  </tbody>
</table>
