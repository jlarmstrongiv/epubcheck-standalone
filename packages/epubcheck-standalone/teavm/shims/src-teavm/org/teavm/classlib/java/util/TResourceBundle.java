/*
 *  Copyright 2017 Alexey Andreev.
 *
 *  Licensed under the Apache License, Version 2.0 (the "License");
 *  you may not use this file except in compliance with the License.
 *  You may obtain a copy of the License at
 *
 *       http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software
 *  distributed under the License is distributed on an "AS IS" BASIS,
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  See the License for the specific language governing permissions and
 *  limitations under the License.
 */

package org.teavm.classlib.java.util;

import java.util.Enumeration;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.MissingResourceException;
import java.util.ResourceBundle;
import java.util.function.Supplier;
import org.teavm.classlib.impl.ResourceBundleImpl;

public abstract class TResourceBundle {
    protected TResourceBundle parent;

    private Locale locale;

    static class MissingBundle extends TResourceBundle {
        @Override
        public Enumeration<String> getKeys() {
            return null;
        }

        @Override
        public Object handleGetObject(String name) {
            return null;
        }
    }

    private static final TResourceBundle MISSING = new MissingBundle();

    private static final TResourceBundle MISSINGBASE = new MissingBundle();

    private static final Map<String, TResourceBundle> cache = new HashMap<>();

    private static final Map<String, Supplier<ResourceBundle>> bundleProviders =
            ResourceBundleImpl.createBundleMap(false);

    private String name;

    public TResourceBundle() {
    }

    public static TResourceBundle getBundle(String bundleName)
            throws MissingResourceException {
        return getBundleImpl(bundleName, Locale.getDefault(), ClassLoader.getSystemClassLoader());
    }

    public static TResourceBundle getBundle(String bundleName, Locale locale) {
        return getBundleImpl(bundleName, locale, ClassLoader.getSystemClassLoader());
    }

    public static TResourceBundle getBundle(String bundleName, Locale locale, ClassLoader loader)
            throws MissingResourceException {
        if (loader == null) {
            throw new NullPointerException();
        }
        if (bundleName != null) {
            TResourceBundle bundle;
            if (!locale.equals(Locale.getDefault())) {
                bundle = handleGetBundle(bundleName, "_" + locale, false);
                if (bundle != null) {
                    return bundle;
                }
            }
            bundle = handleGetBundle(bundleName, "_" + Locale.getDefault(), true);
            if (bundle != null) {
                return bundle;
            }
            throw new MissingResourceException("Bundle not found", bundleName + "_" + locale, "");
        }
        throw new NullPointerException();
    }

    private static TResourceBundle getBundleImpl(String bundleName, Locale locale, ClassLoader loader)
            throws MissingResourceException {
        if (bundleName != null) {
            TResourceBundle bundle;
            if (!locale.equals(Locale.getDefault())) {
                String localeName = locale.toString();
                if (localeName.length() > 0) {
                    localeName = "_" + localeName;
                }
                bundle = handleGetBundle(bundleName, localeName, false);
                if (bundle != null) {
                    return bundle;
                }
            }
            String localeName = Locale.getDefault().toString();
            if (localeName.length() > 0) {
                localeName = "_" + localeName;
            }
            bundle = handleGetBundle(bundleName, localeName, true);
            if (bundle != null) {
                return bundle;
            }
            throw new MissingResourceException("Bundle not found", bundleName + '_' + locale, "");
        }
        throw new NullPointerException();
    }

    public abstract Enumeration<String> getKeys();

    public Locale getLocale() {
        return locale;
    }

    public String getBaseBundleName() {
        return name;
    }

    public final Object getObject(String key) {
        TResourceBundle last;
        TResourceBundle theParent = this;
        do {
            Object result = theParent.handleGetObject(key);
            if (result != null) {
                return result;
            }
            last = theParent;
            theParent = theParent.parent;
        } while (theParent != null);
        // --- epubcheck-standalone TeaVM shim workaround (fork of the stock classlib file) ---
        // TeaVM 0.15.0 CPS-lowering bug: epubcheck's
        // LocalizedMessages.getStringFromBundle compiles to a state machine in
        // which the catch handler after the (async) getString call reads a
        // local whose constant "" initializer was dropped on the first-pass
        // path -- the caught MissingResourceException makes it return JS
        // `undefined` instead of "". The only by-design missing keys epubcheck
        // ever looks up are the optional suggestion family ("<ID>_SUG",
        // "<ID>_SUG.<variant>"); returning "" for exactly those keys yields
        // the same net behavior as the JDK (epubcheck maps the exception to ""
        // anyway) without ever entering the miscompiled handler. All other
        // consumers (ICU fallback chains, Jing, Xerces, Saxon) keep real
        // MissingResourceException semantics.
        if (key != null && key.contains("_SUG")) {
            return "";
        }
        throw new MissingResourceException("", last.getClass().getName(), key);
    }

    public boolean containsKey(String key) {
        TResourceBundle theParent = this;
        do {
            Object result = theParent.handleGetObject(key);
            if (result != null) {
                return true;
            }
            theParent = theParent.parent;
        } while (theParent != null);
        return false;
    }
    
    public final String getString(String key) {
        return (String) getObject(key);
    }

    public final String[] getStringArray(String key) {
        return (String[]) getObject(key);
    }

    private static TResourceBundle handleGetBundle(String base, String locale, boolean loadBase) {
        TResourceBundle bundle;
        String bundleName = base + locale;
        TResourceBundle result = cache.get(bundleName);
        if (result != null) {
            if (result == MISSINGBASE) {
                return null;
            }
            if (result == MISSING) {
                if (!loadBase) {
                    return null;
                }
                String extension = strip(locale);
                if (extension == null) {
                    return null;
                }
                return handleGetBundle(base, extension, loadBase);
            }
            return result;
        }

        Supplier<ResourceBundle> provider = bundleProviders.get(bundleName);
        bundle = provider != null ? (TResourceBundle) (Object) provider.get() : null;
        // epubcheck-standalone shim: fall back to runtime classpath resources (the
        // build-time provider map only covers bundles opted in through
        // META-INF/services/java.util.ResourceBundle, which epubcheck's
        // dependencies do not use).
        if (bundle == null) {
            bundle = loadPropertyBundle(bundleName);
        }

        String extension = strip(locale);
        if (bundle != null) {
            if (extension != null) {
                TResourceBundle parent = handleGetBundle(base, extension, true);
                if (parent != null) {
                    bundle.setParent(parent);
                }
            }
            cache.put(bundleName, bundle);
            bundle.name = base;
            return bundle;
        }

        if (extension != null && (loadBase || extension.length() > 0)) {
            bundle = handleGetBundle(base, extension, loadBase);
            if (bundle != null) {
                cache.put(bundleName, bundle);
                bundle.name = base;
                return bundle;
            }
        }
        cache.put(bundleName, loadBase ? MISSINGBASE : MISSING);
        return null;
    }

    protected abstract Object handleGetObject(String key);

    protected void setParent(TResourceBundle bundle) {
        parent = bundle;
    }

    private static String strip(String name) {
        int index = name.lastIndexOf('_');
        if (index != -1) {
            return name.substring(0, index);
        }
        return null;
    }

    private void setLocale(String name) {
        String language = "";
        String country = "";
        String variant = "";
        if (name.length() > 1) {
            int nextIndex = name.indexOf('_', 1);
            if (nextIndex == -1) {
                nextIndex = name.length();
            }
            language = name.substring(1, nextIndex);
            if (nextIndex + 1 < name.length()) {
                int index = nextIndex;
                nextIndex = name.indexOf('_', nextIndex + 1);
                if (nextIndex == -1) {
                    nextIndex = name.length();
                }
                country = name.substring(index + 1, nextIndex);
                if (nextIndex + 1 < name.length()) {
                    variant = name.substring(nextIndex + 1);
                }
            }
        }
        locale = new Locale(language, country, variant);
    }

    // --- epubcheck-standalone TeaVM shim additions (fork of the stock classlib file) ---

    private static TResourceBundle loadPropertyBundle(String bundleName) {
        java.io.InputStream in = ClassLoader.getSystemClassLoader()
                .getResourceAsStream(bundleName.replace('.', '/') + ".properties");
        if (in == null) {
            return null;
        }
        try {
            return (TResourceBundle) (Object) new java.util.PropertyResourceBundle(in);
        } catch (java.io.IOException e) {
            return null;
        } finally {
            try {
                in.close();
            } catch (java.io.IOException e) {
                // in-memory stream: cannot happen
            }
        }
    }

    /**
     * Standard {@code ResourceBundle.Control} surface, sufficient for
     * epubcheck's Messages$UTF8Control (which overrides newBundle and calls
     * toBundleName/toResourceName) and for the default properties format.
     */
    public static class Control {
        public static final java.util.List<String> FORMAT_DEFAULT =
                java.util.Arrays.asList("java.class", "java.properties");
        public static final java.util.List<String> FORMAT_CLASS =
                java.util.Arrays.asList("java.class");
        public static final java.util.List<String> FORMAT_PROPERTIES =
                java.util.Arrays.asList("java.properties");
        public static final long TTL_DONT_CACHE = -1;
        public static final long TTL_NO_EXPIRATION_CONTROL = -2;

        protected Control() {
        }

        public static Control getControl(java.util.List<String> formats) {
            return new Control();
        }

        public java.util.List<String> getFormats(String baseName) {
            return FORMAT_PROPERTIES;
        }

        public java.util.List<Locale> getCandidateLocales(String baseName, Locale locale) {
            java.util.List<Locale> out = new java.util.ArrayList<>();
            String lang = locale.getLanguage();
            String ctry = locale.getCountry();
            String var = locale.getVariant();
            if (!var.isEmpty()) {
                out.add(new Locale(lang, ctry, var));
            }
            if (!ctry.isEmpty()) {
                out.add(new Locale(lang, ctry));
            }
            if (!lang.isEmpty()) {
                out.add(new Locale(lang));
            }
            out.add(new Locale("", "", ""));
            return out;
        }

        public Locale getFallbackLocale(String baseName, Locale locale) {
            return null;
        }

        public String toBundleName(String baseName, Locale locale) {
            String language = locale.getLanguage();
            String country = locale.getCountry();
            String variant = locale.getVariant();
            if (language.isEmpty() && country.isEmpty() && variant.isEmpty()) {
                return baseName;
            }
            StringBuilder sb = new StringBuilder(baseName);
            sb.append('_');
            if (!variant.isEmpty()) {
                sb.append(language).append('_').append(country).append('_').append(variant);
            } else if (!country.isEmpty()) {
                sb.append(language).append('_').append(country);
            } else {
                sb.append(language);
            }
            return sb.toString();
        }

        public final String toResourceName(String bundleName, String suffix) {
            return bundleName.replace('.', '/') + '.' + suffix;
        }

        public ResourceBundle newBundle(String baseName, Locale locale, String format,
                ClassLoader loader, boolean reload)
                throws IllegalAccessException, InstantiationException, java.io.IOException {
            if (!"java.properties".equals(format)) {
                return null;
            }
            String resourceName = toResourceName(toBundleName(baseName, locale), "properties");
            java.io.InputStream in = loader.getResourceAsStream(resourceName);
            if (in == null) {
                return null;
            }
            try {
                return (ResourceBundle) (Object) new java.util.PropertyResourceBundle(in);
            } finally {
                in.close();
            }
        }

        public long getTimeToLive(String baseName, Locale locale) {
            return TTL_NO_EXPIRATION_CONTROL;
        }

        public boolean needsReload(String baseName, Locale locale, String format,
                ClassLoader loader, ResourceBundle bundle, long loadTime) {
            return false;
        }
    }

    public static TResourceBundle getBundle(String baseName, Locale targetLocale, Control control) {
        if (baseName == null || targetLocale == null || control == null) {
            throw new NullPointerException();
        }
        String cacheKey = "ctl:" + baseName + "_" + targetLocale;
        TResourceBundle cached = cache.get(cacheKey);
        if (cached != null) {
            if (cached == MISSING || cached == MISSINGBASE) {
                throw new MissingResourceException("Bundle not found", baseName + "_" + targetLocale, "");
            }
            return cached;
        }
        java.util.List<Locale> candidates = control.getCandidateLocales(baseName, targetLocale);
        TResourceBundle prev = null;
        TResourceBundle mostSpecific = null;
        for (int i = candidates.size() - 1; i >= 0; --i) {
            Locale candidate = candidates.get(i);
            TResourceBundle b = null;
            for (String format : control.getFormats(baseName)) {
                try {
                    b = (TResourceBundle) (Object) control.newBundle(baseName, candidate, format,
                            ClassLoader.getSystemClassLoader(), false);
                } catch (Exception e) {
                    b = null;
                }
                if (b != null) {
                    break;
                }
            }
            if (b != null) {
                if (prev != null) {
                    b.setParent(prev);
                }
                prev = b;
                mostSpecific = b;
            }
        }
        if (mostSpecific == null) {
            cache.put(cacheKey, MISSINGBASE);
            throw new MissingResourceException("Bundle not found", baseName + "_" + targetLocale, "");
        }
        mostSpecific.name = baseName;
        cache.put(cacheKey, mostSpecific);
        return mostSpecific;
    }

}
