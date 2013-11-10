var SourceMapConsumer = require('source-map').SourceMapConsumer;
var path = require('path');
var fs = require('fs');

var alreadyInstalled = false;

// If true, the caches are reset before a stack trace formatting operation
var emptyCacheBetweenOperations = false;

// Maps a file path to a string containing the file contents
var fileContentsCache = {};

// Maps a file path to a source map for that file
var sourceMapCache = {};

function isInBrowser() {
  return typeof window !== 'undefined';
}

function retrieveFile(path) {
  if (path in fileContentsCache) {
    return fileContentsCache[path];
  }

  try {
    // Use SJAX if we are in the browser
    if (isInBrowser()) {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', path, false);
      xhr.send(null);
      var contents = xhr.readyState === 4 ? xhr.responseText : null;
    }

    // Otherwise, use the filesystem
    else {
      var contents = fs.readFileSync(path, 'utf8');
    }
  } catch (e) {
    var contents = null;
  }

  return fileContentsCache[path] = contents;
}

// Support URLs relative to a directory, but be careful about a protocol prefix
// in case we are in the browser (i.e. directories may start with "http://")
function supportRelativeURL(dir, url) {
  var match = /^\w+:\/\/[^\/]*/.exec(dir);
  var protocol = match ? match[0] : '';
  return protocol + path.resolve(dir.slice(protocol.length), url);
}

// Can be overridden by the retrieveSourceMap option to install. Takes a
// generated source filename; returns a {map, optional url} object, or null if
// there is no source map.  The map field may be either a string or the parsed
// JSON object (ie, it must be a valid argument to the SourceMapConsumer
// constructor).
var retrieveSourceMap = function (source) {
  // Get the URL of the source map
  var fileData = retrieveFile(source);
  var match = /\/\/[#@]\s*sourceMappingURL=(.*)\s*$/m.exec(fileData);
  if (!match) return null;
  var sourceMappingURL = match[1];

  // Read the contents of the source map
  var sourceMapData;
  var dataUrlPrefix = "data:application/json;base64,";
  if (sourceMappingURL.slice(0, dataUrlPrefix.length).toLowerCase() == dataUrlPrefix) {
    // Support source map URL as a data url
    sourceMapData = new Buffer(sourceMappingURL.slice(dataUrlPrefix.length), "base64").toString();
  } else {
    // Support source map URLs relative to the source URL
    var dir = path.dirname(source);
    sourceMappingURL = supportRelativeURL(dir, sourceMappingURL);
    sourceMapData = retrieveFile(sourceMappingURL, 'utf8');
  }

  if (!sourceMapData) {
    return null;
  }

  return {
    url: sourceMappingURL,
    map: sourceMapData
  };
};

var mapSourcePosition = exports.mapSourcePosition = function(position) {
  var sourceMap = sourceMapCache[position.source];
  if (!sourceMap) {
    // Call the (overrideable) retrieveSourceMap function to get the source map.
    var urlAndMap = retrieveSourceMap(position.source);
    if (urlAndMap) {
      sourceMap = sourceMapCache[position.source] = {
        url: urlAndMap.url,
        map: new SourceMapConsumer(urlAndMap.map)
      };
    }
  }

  // Resolve the source URL relative to the URL of the source map
  if (sourceMap) {
    var originalPosition = sourceMap.map.originalPositionFor(position);

    // Only return the original position if a matching line was found. If no
    // matching line is found then we return position instead, which will cause
    // the stack trace to print the path and line for the compiled file. It is
    // better to give a precise location in the compiled file than a vague
    // location in the original file.
    if (originalPosition.source !== null) {
      if (sourceMap.url) {
        originalPosition.source = supportRelativeURL(
          path.dirname(sourceMap.url), originalPosition.source);
      }
      return originalPosition;
    }
  }

  return position;
};

// Parses code generated by FormatEvalOrigin(), a function inside V8:
// https://code.google.com/p/v8/source/browse/trunk/src/messages.js
function mapEvalOrigin(origin) {
  // Most eval() calls are in this format
  var match = /^eval at ([^(]+) \((.+):(\d+):(\d+)\)$/.exec(origin);
  if (match) {
    var position = mapSourcePosition({
      source: match[2],
      line: match[3],
      column: match[4]
    });
    return 'eval at ' + match[1] + ' (' + position.source + ':' +
      position.line + ':' + position.column + ')';
  }

  // Parse nested eval() calls using recursion
  match = /^eval at ([^(]+) \((.+)\)$/.exec(origin);
  if (match) {
    return 'eval at ' + match[1] + ' (' + mapEvalOrigin(match[2]) + ')';
  }

  // Make sure we still return useful information if we didn't find anything
  return origin;
}

function wrapCallSite(frame) {
  // Most call sites will return the source file from getFileName(), but code
  // passed to eval() ending in "//# sourceURL=..." will return the source file
  // from getScriptNameOrSourceURL() instead
  var source = frame.getFileName() || frame.getScriptNameOrSourceURL();
  if (source) {
    var position = mapSourcePosition({
      source: source,
      line: frame.getLineNumber(),
      column: frame.getColumnNumber()
    });
    return {
      __proto__: frame,
      getFileName: function() { return position.source; },
      getLineNumber: function() { return position.line; },
      getColumnNumber: function() { return position.column; },
      getScriptNameOrSourceURL: function() { return position.source; }
    };
  }

  // Code called using eval() needs special handling
  var origin = frame.isEval() && frame.getEvalOrigin();
  if (origin) {
    origin = mapEvalOrigin(origin);
    return {
      __proto__: frame,
      getEvalOrigin: function() { return origin; }
    };
  }

  // If we get here then we were unable to change the source position
  return frame;
}

// This function is part of the V8 stack trace API, for more info see:
// http://code.google.com/p/v8/wiki/JavaScriptStackTraceApi
function prepareStackTrace(error, stack) {
  if (emptyCacheBetweenOperations) {
    fileContentsCache = {};
    sourceMapCache = {};
  }
  return error + stack.map(function(frame) {
    return '\n    at ' + wrapCallSite(frame);
  }).join('');
}

// Mimic node's stack trace printing when an exception escapes the process
function handleUncaughtExceptions(error) {
  if (!error || !error.stack) {
    console.log('Uncaught exception:', error);
    process.exit();
  }
  var match = /\n    at [^(]+ \((.*):(\d+):(\d+)\)/.exec(error.stack);
  if (match) {
    var position = mapSourcePosition({
      source: match[1],
      line: match[2],
      column: match[3]
    });
    if (fs.existsSync(position.source)) {
      var contents = fs.readFileSync(position.source, 'utf8');
      var line = contents.split(/(?:\r\n|\r|\n)/)[position.line - 1];
      if (line) {
        console.log('\n' + position.source + ':' + position.line);
        console.log(line);
        console.log(new Array(+position.column).join(' ') + '^');
      }
    }
  }
  console.log(error.stack);
  process.exit();
}

exports.install = function(options) {
  if (!alreadyInstalled) {
    alreadyInstalled = true;
    Error.prepareStackTrace = prepareStackTrace;

    // Configure options
    options = options || {};
    var installHandler = 'handleUncaughtExceptions' in options ?
      options.handleUncaughtExceptions : true;
    emptyCacheBetweenOperations = 'emptyCacheBetweenOperations' in options ?
      options.emptyCacheBetweenOperations : false;

    // Allow source maps to be found by methods other than reading the files
    // directly from disk.
    if (options.retrieveSourceMap)
      retrieveSourceMap = options.retrieveSourceMap;

    // Provide the option to not install the uncaught exception handler. This is
    // to support other uncaught exception handlers (in test frameworks, for
    // example). If this handler is not installed and there are no other uncaught
    // exception handlers, uncaught exceptions will be caught by node's built-in
    // exception handler and the process will still be terminated. However, the
    // generated JavaScript code will be shown above the stack trace instead of
    // the original source code.
    if (installHandler && !isInBrowser()) {
      process.on('uncaughtException', handleUncaughtExceptions);
    }
  }
};
