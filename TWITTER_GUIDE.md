# Social Share Extractor - Twitter/X Guide

## Twitter/X Automated Extraction

This extension now includes **automated Twitter/X data extraction** with the following workflow:

### 📋 What It Extracts

#### 1. Main Post Data
- ✅ Timestamp (ISO format + readable)
- ✅ View count
- ✅ Repost count  
- ✅ Like count
- ✅ Reply count
- ✅ Username & display name
- ✅ Tweet text
- ✅ Tweet URL
- ✅ Profile URL

#### 2. Quotes (Quote Tweets)
- ✅ All quote tweet metadata
- ✅ Timestamps for each quote
- ✅ Username, display name
- ✅ Quote text
- ✅ Engagement metrics (reposts, likes, replies)
- ✅ Tweet URL
- ✅ Profile URL
- ✅ Original quoted tweet URL

#### 3. Reposts (Regular Retweets)
- ✅ Username & display name
- ✅ Profile URL
- ✅ User bio
- ✅ Following status
- ⚠️ **Note:** Reposts pages don't have timestamps (Twitter limitation)

---

## 🚀 How to Use

### Method 1: Automatic Navigation (from Tweet Detail Page)

1. **Navigate to a tweet** (e.g., `https://x.com/username/status/123456`)
2. **Click the extension icon**
3. **Click "Extract Data"**
4. The extension will:
   - Extract main post data
   - Click the repost button
   - Click "View Quotes"
   - Navigate to quotes page
5. **Run extraction again on quotes page** to collect all quote tweets
6. **Manually navigate to Reposts tab** and run extraction again for reposts

### Method 2: Direct Extraction (Recommended)

#### Step A: Extract Main Post
1. Navigate to the tweet: `https://x.com/username/status/123456`
2. Click extension → "Extract Data"
3. Main post data will be collected

#### Step B: Extract Quotes
1. Click the **repost count** on the tweet
2. Click the **"Quotes"** tab in the modal
3. Or directly navigate to: `https://x.com/username/status/123456/quotes`
4. **Scroll down** to load all quotes (if many)
5. Click extension → "Extract Data"
6. All visible quote tweets will be collected

#### Step C: Extract Reposts
1. From the same modal, click the **"Reposts"** tab
2. Or navigate to: `https://x.com/username/status/123456/retweets`
3. **Scroll down** to load all reposts
4. Click extension → "Extract Data"
5. All visible reposts will be collected

---

## 📊 Export Options

After extraction, export your data as:

- **JSON**: Complete structured data
- **CSV**: Spreadsheet-compatible
- **TSV**: Tab-separated values
- **Copy to clipboard**: Quick sharing

### CSV Export Structure

#### Main Post:
```csv
Type,Username,Display Name,Timestamp,View Count,Repost Count,Like Count,Tweet URL,Profile URL
MAIN_POST,@username,John Doe,2024-12-03T14:57:09.000Z,1.2K,54,234,https://x.com/...,https://x.com/username
```

#### Quotes:
```csv
Type,Index,Username,Display Name,Timestamp,Tweet Text,Repost Count,Like Count,Tweet URL,Profile URL
QUOTE,0,@user1,Jane Smith,2024-12-03T15:03:08.000Z,"Great point!",12,45,https://x.com/...,https://x.com/user1
QUOTE,1,@user2,Bob Jones,2024-12-03T19:45:17.000Z,"Totally agree",0,3,https://x.com/...,https://x.com/user2
```

#### Reposts:
```csv
Type,Index,Username,Display Name,Bio,Following Status,Profile URL
REPOST,0,@user3,Alice Brown,"Tech enthusiast | Developer",Following,https://x.com/user3
REPOST,1,@user4,Charlie Wilson,"Marketing professional",Follow,https://x.com/user4
```

---

## ⚙️ Technical Details

### Page Type Detection

The extension automatically detects:
- **Tweet detail page**: `/status/123456`
- **Quotes page**: `/status/123456/quotes`
- **Reposts page**: `/status/123456/retweets`

### Data Extraction Methods

**Main Post** - Selectors:
- `article[data-testid="tweet"]` (first article)
- `time[datetime]` for timestamp
- `[data-testid="User-Name"]` for user info
- Button aria-labels for engagement counts

**Quotes** - Selectors:
- `article[data-testid="tweet"]` (all articles)
- Individual timestamp per quote
- `[data-testid="tweetText"]` for quote text
- Engagement buttons for metrics

**Reposts** - Selectors:
- `[data-testid="UserCell"]` for user containers
- `[data-testid="UserAvatar-Container-{username}"]` for username extraction
- No timestamps available (Twitter doesn't provide them)

### Known Limitations

1. **Repost Timestamps**: Twitter's Reposts page doesn't include timestamp data in the HTML. This is a platform limitation, not an extension bug.

2. **Pagination**: You must scroll down to load more results before extraction. The extension only extracts visible items.

3. **Rate Limiting**: Extracting very large datasets (1000+ items) may trigger Twitter's rate limits.

4. **Private/Protected Accounts**: Cannot extract data from protected users.

---

## 🔍 Troubleshooting

### "No data found"
- Make sure you're on the correct page type (quotes or reposts)
- Scroll down to load content
- Check that the tweet has quotes/reposts

### "Script returned no data"
- Refresh the page and try again
- Make sure JavaScript is enabled
- Check browser console for errors (F12)

### Missing engagement counts
- Some counts are only visible on the main tweet page
- Quotes/reposts may not show all metrics

### Repost timestamps showing "N/A"
- This is normal - Twitter doesn't provide repost timestamps
- Only quote tweets have timestamps

---

## 📝 Data Fields Reference

### Main Post Fields
| Field | Description | Example |
|-------|-------------|---------|
| `type` | Entry type | `MAIN_POST` |
| `timestamp` | ISO timestamp | `2024-12-03T14:57:09.000Z` |
| `timestampText` | Human-readable | `Dec 3, 2024` |
| `viewCount` | View count | `1.2K Views` |
| `repostCount` | Repost count | `54` |
| `likeCount` | Like count | `234` |
| `username` | Handle | `@username` |
| `displayName` | Display name | `John Doe` |
| `tweetText` | Tweet content | `Hello world!` |
| `tweetUrl` | Tweet URL | `https://x.com/user/status/123` |
| `profileUrl` | Profile URL | `https://x.com/username` |

### Quote Fields
| Field | Description |
|-------|-------------|
| `type` | `QUOTE` |
| `index` | Quote number (0-based) |
| `timestamp` | Quote timestamp (ISO) |
| `timestampText` | Readable timestamp |
| `username` | Quoter's handle |
| `displayName` | Quoter's name |
| `tweetText` | Quote text |
| `tweetUrl` | Quote tweet URL |
| `profileUrl` | Quoter's profile |
| `quotedTweetUrl` | Original tweet URL |
| `repostCount` | Quote's reposts |
| `likeCount` | Quote's likes |
| `replyCount` | Quote's replies |

### Repost Fields
| Field | Description |
|-------|-------------|
| `type` | `REPOST` |
| `index` | Repost number (0-based) |
| `timestamp` | Always `N/A` (not available) |
| `username` | Reposter's handle |
| `displayName` | Reposter's name |
| `profileUrl` | Reposter's profile |
| `bio` | User bio (truncated) |
| `followingStatus` | Follow/Following status |

---

## 🎯 Best Practices

1. **Load all data first**: Scroll to bottom before extracting
2. **Extract in order**: Main post → Quotes → Reposts
3. **Save regularly**: Export after each extraction
4. **Combine data**: Use JSON export to merge all extractions
5. **Respect rate limits**: Don't extract too frequently

---

## 🔄 Workflow Example

**Scenario**: Extract all engagement from a viral tweet

```
1. Navigate to tweet: https://x.com/republic/status/1863958412842951143
2. Extract main post data
3. Export → Save as "main-post.json"
4. Navigate to /quotes
5. Scroll to load all quotes
6. Extract quotes
7. Export → Save as "quotes.json"
8. Navigate to /retweets  
9. Scroll to load all reposts
10. Extract reposts
11. Export → Save as "reposts.json"
12. Combine all JSON files for analysis
```

---

## 💡 Tips

- **Use filters**: After extraction, filter by type using the tabs
- **CSV for analysis**: Export to CSV for Excel/Google Sheets
- **JSON for archiving**: JSON preserves all metadata
- **Incremental extraction**: Extract quotes/reposts separately for better control

---

## Facebook Extraction

Facebook extraction remains unchanged. Use the extension on Facebook's "People who shared this" dialog to extract Facebook shares with timestamps and profile links.

---

## Support

For issues or questions, check the browser console (F12) for detailed logs. The extension logs all extraction steps for debugging.
