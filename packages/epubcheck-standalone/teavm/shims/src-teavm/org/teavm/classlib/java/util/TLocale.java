/*
 *  Copyright 2014 Alexey Andreev.
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
/*
 *  Licensed to the Apache Software Foundation (ASF) under one or more
 *  contributor license agreements.  See the NOTICE file distributed with
 *  this work for additional information regarding copyright ownership.
 *  The ASF licenses this file to You under the Apache License, Version 2.0
 *  (the "License"); you may not use this file except in compliance with
 *  the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software
 *  distributed under the License is distributed on an "AS IS" BASIS,
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  See the License for the specific language governing permissions and
 *  limitations under the License.
 */

package org.teavm.classlib.java.util;

import java.util.Arrays;
import org.teavm.classlib.impl.unicode.CLDRHelper;
import org.teavm.classlib.java.io.TSerializable;
import org.teavm.classlib.java.lang.TCloneable;
import org.teavm.classlib.java.lang.TString;
import org.teavm.platform.metadata.ResourceArray;
import org.teavm.platform.metadata.ResourceMap;
import org.teavm.platform.metadata.StringResource;

public final class TLocale implements TCloneable, TSerializable {
    private static TLocale defaultLocale;
    public static final TLocale CANADA = new TLocale("en", "CA");
    public static final TLocale CANADA_FRENCH = new TLocale("fr", "CA");
    public static final TLocale CHINA = new TLocale("zh", "CN");
    public static final TLocale CHINESE = new TLocale("zh", "");
    public static final TLocale ENGLISH = new TLocale("en", "");
    public static final TLocale FRANCE = new TLocale("fr", "FR");
    public static final TLocale FRENCH = new TLocale("fr", "");
    public static final TLocale GERMAN = new TLocale("de", "");
    public static final TLocale GERMANY = new TLocale("de", "DE");
    public static final TLocale ITALIAN = new TLocale("it", "");
    public static final TLocale ITALY = new TLocale("it", "IT");
    public static final TLocale JAPAN = new TLocale("ja", "JP");
    public static final TLocale JAPANESE = new TLocale("ja", "");
    public static final TLocale KOREA = new TLocale("ko", "KR");
    public static final TLocale KOREAN = new TLocale("ko", "");
    public static final TLocale PRC = new TLocale("zh", "CN");
    public static final TLocale SIMPLIFIED_CHINESE = new TLocale("zh", "CN");
    public static final TLocale TAIWAN = new TLocale("zh", "TW");
    public static final TLocale TRADITIONAL_CHINESE = new TLocale("zh", "TW");
    public static final TLocale UK = new TLocale("en", "GB");
    public static final TLocale US = new TLocale("en", "US");
    public static final TLocale ROOT = new TLocale("", "");
    private static TLocale[] availableLocales;

    static {
        String localeName = CLDRHelper.getDefaultLocale().getValue();
        int countryIndex = localeName.indexOf('_');
        defaultLocale = new TLocale(localeName.substring(0, countryIndex), localeName.substring(countryIndex + 1), "");
    }

    private transient String countryCode;
    private transient String languageCode;
    private transient String variantCode;

    public TLocale(String language) {
        this(language, "", "");
    }

    public TLocale(String language, String country) {
        this(language, country, "");
    }

    public TLocale(String language, String country, String variant) {
        if (language == null || country == null || variant == null) {
            throw new NullPointerException();
        }
        if (language.isEmpty() && country.isEmpty()) {
            languageCode = "";
            countryCode = "";
            variantCode = variant;
            return;
        }
        languageCode = language;
        countryCode = country;
        variantCode = variant;
    }

    @Override
    public Object clone() {
        try {
            return super.clone();
        } catch (CloneNotSupportedException e) {
            return null;
        }
    }

    @Override
    public boolean equals(Object object) {
        if (object == this) {
            return true;
        }
        if (object instanceof TLocale) {
            TLocale o = (TLocale) object;
            return languageCode.equals(o.languageCode) && countryCode.equals(o.countryCode)
                    && variantCode.equals(o.variantCode);
        }
        return false;
    }

    public static TLocale[] getAvailableLocales() {
        if (availableLocales == null) {
            ResourceArray<StringResource> strings = CLDRHelper.getAvailableLocales();
            availableLocales = new TLocale[strings.size()];
            for (int i = 0; i < strings.size(); ++i) {
                String string = strings.get(i).getValue();
                int countryIndex = string.indexOf('-');
                if (countryIndex > 0) {
                    availableLocales[i] = new TLocale(string.substring(0, countryIndex),
                            string.substring(countryIndex + 1));
                } else {
                    availableLocales[i] = new TLocale(string);
                }
            }
        }
        return Arrays.copyOf(availableLocales, availableLocales.length);
    }

    public String getCountry() {
        return countryCode;
    }

    public static TLocale getDefault() {
        return defaultLocale;
    }

    public String getDisplayCountry() {
        return getDisplayCountry(getDefault());
    }

    public String getDisplayCountry(TLocale locale) {
        String result = getDisplayCountry(locale.getLanguage() + "-" + locale.getCountry(), countryCode);
        if (result == null) {
            result = getDisplayCountry(locale.getLanguage(), countryCode);
        }
        return result != null ? result : countryCode;
    }

    private static String getDisplayCountry(String localeName, String country) {
        if (!CLDRHelper.getCountriesMap().has(localeName)) {
            return null;
        }
        ResourceMap<StringResource> countries = CLDRHelper.getCountriesMap().get(localeName);
        if (!countries.has(country)) {
            return null;
        }
        return countries.get(country).getValue();
    }

    public String getDisplayLanguage() {
        return getDisplayLanguage(getDefault());
    }

    public String getDisplayLanguage(TLocale locale) {
        String result = getDisplayLanguage(locale.getLanguage() + "-" + locale.getCountry(), languageCode);
        if (result == null) {
            result = getDisplayLanguage(locale.getLanguage(), languageCode);
        }
        return result != null ? result : languageCode;
    }

    private static String getDisplayLanguage(String localeName, String language) {
        if (!CLDRHelper.getLanguagesMap().has(localeName)) {
            return null;
        }
        ResourceMap<StringResource> languages = CLDRHelper.getLanguagesMap().get(localeName);
        if (!languages.has(language)) {
            return null;
        }
        return languages.get(language).getValue();
    }

    public String getDisplayName() {
        return getDisplayName(getDefault());
    }

    public String getDisplayName(TLocale locale) {
        int count = 0;
        StringBuilder buffer = new StringBuilder();
        if (!languageCode.isEmpty()) {
            buffer.append(getDisplayLanguage(locale));
            count++;
        }
        if (!countryCode.isEmpty()) {
            if (count == 1) {
                buffer.append(" (");
            }
            buffer.append(getDisplayCountry(locale));
            count++;
        }
        if (!variantCode.isEmpty()) {
            if (count == 1) {
                buffer.append(" (");
            } else if (count == 2) {
                buffer.append(",");
            }
            buffer.append(getDisplayVariant(locale));
            count++;
        }
        if (count > 1) {
            buffer.append(")");
        }
        return buffer.toString();
    }

    public String getDisplayVariant() {
        return getDisplayVariant(getDefault());
    }

    public String getDisplayVariant(TLocale locale) {
        // TODO: use CLDR
        return locale.getVariant();
    }

    public String getLanguage() {
        return languageCode;
    }

    public String getVariant() {
        return variantCode;
    }

    @Override
    public int hashCode() {
        return countryCode.hashCode() + languageCode.hashCode() + variantCode.hashCode();
    }

    public static void setDefault(TLocale locale) {
        if (locale != null) {
            defaultLocale = locale;
        } else {
            throw new NullPointerException();
        }
    }

    @Override
    public String toString() {
        StringBuilder result = new StringBuilder();
        result.append(languageCode);
        if (!countryCode.isEmpty()) {
            result.append('_');
            result.append(countryCode);
        }
        if (!variantCode.isEmpty() && result.length() > 0) {
            if (countryCode.isEmpty()) {
                result.append("__");
            } else {
                result.append('_');
            }
            result.append(variantCode);
        }
        return result.toString();
    }

    public TString toLanguageTag() {
        StringBuilder result = new StringBuilder();
        result.append(languageCode.isEmpty() ? "und" : languageCode);
        if (!countryCode.isEmpty()) {
            result.append('-');
            result.append(countryCode);
        }
        if (!variantCode.isEmpty() && result.length() > 0) {
            result.append('-');
            result.append(variantCode);
        }
        return new TString(result.toString().toCharArray());
    }

    // --- epubcheck-standalone TeaVM shim additions (fork of the stock classlib file) ---

    public static TLocale forLanguageTag(String languageTag) {
        if (languageTag == null || languageTag.isEmpty() || "und".equals(languageTag)) {
            return new TLocale("", "", "");
        }
        String[] parts = languageTag.replace('_', '-').split("-");
        String language = "";
        String region = "";
        StringBuilder variant = new StringBuilder();
        int i = 0;
        if (i < parts.length && isAlpha(parts[i]) && parts[i].length() >= 2 && parts[i].length() <= 8) {
            language = parts[i].toLowerCase();
            i++;
        }
        // Optional 4-letter script subtag: accepted and dropped (this fork does not model scripts).
        if (i < parts.length && parts[i].length() == 4 && isAlpha(parts[i])) {
            i++;
        }
        if (i < parts.length && ((parts[i].length() == 2 && isAlpha(parts[i]))
                || (parts[i].length() == 3 && isDigits(parts[i])))) {
            region = parts[i].toUpperCase();
            i++;
        }
        while (i < parts.length) {
            if (parts[i].length() == 1) {
                break; // extension singletons: not modeled
            }
            if (variant.length() > 0) {
                variant.append('_');
            }
            variant.append(parts[i]);
            i++;
        }
        return new TLocale(language, region, variant.toString());
    }

    private static boolean isAlpha(String s) {
        for (int i = 0; i < s.length(); ++i) {
            char c = s.charAt(i);
            if ((c < 'a' || c > 'z') && (c < 'A' || c > 'Z')) {
                return false;
            }
        }
        return !s.isEmpty();
    }

    private static boolean isDigits(String s) {
        for (int i = 0; i < s.length(); ++i) {
            char c = s.charAt(i);
            if (c < '0' || c > '9') {
                return false;
            }
        }
        return !s.isEmpty();
    }

    public String getScript() {
        return "";
    }

    public String getExtension(char key) {
        return null;
    }

    public java.util.Set<java.lang.Character> getExtensionKeys() {
        return java.util.Collections.emptySet();
    }

    public String getUnicodeLocaleType(String key) {
        return null;
    }

    public java.util.Set<String> getUnicodeLocaleKeys() {
        return java.util.Collections.emptySet();
    }

    public java.util.Set<java.lang.Character> getUnicodeLocaleAttributes() {
        return java.util.Collections.emptySet();
    }



    /** Minimal Locale.Builder (fork addition): language/region/variant only. */
    public static final class Builder {
        private String language = "";
        private String region = "";
        private String variant = "";

        public Builder setLanguage(String language) {
            this.language = language == null ? "" : language.toLowerCase();
            return this;
        }

        public Builder setScript(String script) {
            return this;
        }

        public Builder setRegion(String region) {
            this.region = region == null ? "" : region.toUpperCase();
            return this;
        }

        public Builder setVariant(String variant) {
            this.variant = variant == null ? "" : variant;
            return this;
        }

        public Builder setLanguageTag(String languageTag) {
            TLocale parsed = TLocale.forLanguageTag(languageTag);
            this.language = parsed.getLanguage();
            this.region = parsed.getCountry();
            this.variant = parsed.getVariant();
            return this;
        }

        public Builder setExtension(char key, String value) {
            return this;
        }

        public Builder setUnicodeLocaleKeyword(String key, String type) {
            return this;
        }

        public TLocale build() {
            return new TLocale(language, region, variant);
        }
    }

}
