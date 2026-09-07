/*
 * Copyright (c) 2011 Adobe Systems Incorporated
 *
 *  Permission is hereby granted, free of charge, to any person obtaining a copy of
 *  this software and associated documentation files (the "Software"), to deal in
 *  the Software without restriction, including without limitation the rights to
 *  use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
 *  the Software, and to permit persons to whom the Software is furnished to do so,
 *  subject to the following conditions:
 *
 *  The above copyright notice and this permission notice shall be included in all
 *  copies or substantial portions of the Software.
 *
 *  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
 *  FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
 *  COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
 *  IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
 *  CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 *
 */

package com.adobe.epubcheck.util;

import java.io.IOException;
import java.io.InputStream;

import io.mola.galimatias.URL;

/**
 * SHIM-JAR SHADOW of epubcheck 5.3.0's URLResourceProvider (upstream source
 * verbatim except for the http(s) branch) -- the shims jar precedes the
 * epubcheck jars on the TeaVM compiler classpath, so this class replaces the
 * stock one. This is the TeaVM equivalent of the wasm era's GraalVM
 * substitution (build/wrapper/JsHttpSubstitutions.java, kept as reference):
 * it intercepts the ONE method the stock checker opens http(s) URLs through,
 * rerouting those opens to the JS host bridge (ecshim.HostHttp) while leaving
 * every surrounding stock code path untouched -- URL naming in messages, the
 * download handling in EpubCheck's InputStream constructor, and the failure
 * handling all stay epubcheck's own.
 *
 * Non-http(s) URLs keep the original behavior verbatim.
 *
 * galimatias URL.toString() and URL.toJavaURL().toString() serialize
 * identically (toJavaURL wraps the same serialization), so the URL string the
 * JS bridge fetches -- and the one embedded in the parity-pinned exception
 * messages (see ecshim.HostHttp) -- matches the jar's byte for byte.
 */
public class URLResourceProvider implements GenericResourceProvider
{

  public URLResourceProvider()
  {
  }

  public InputStream openStream(URL url) throws
      IOException
  {
    // epubcheck-standalone shim: http(s) opens go through the JS host bridge.
    String s = url.toString();
    if (s.startsWith("http://") || s.startsWith("https://"))
    {
      return ecshim.HostHttp.open(s);
    }
    // Original URLResourceProvider.openStream body (epubcheck 5.3.0).
    return url.toJavaURL().openStream();
  }
}
