// Import cache modules once so quota recovery can reach every disposable owner.
import './importers/anilist/toolsPersistentCache';
import './spotify/spotifyPlaylist';
import '../tools/panels/bumpChartImageCache';
import '../tools/panels/bumpChartMalExportImages';
