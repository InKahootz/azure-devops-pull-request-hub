import "./PullRequestTab.scss";

import * as React from "react";

import {
  AZDEVOPS_CLOUD_API_ORGANIZATION,
  AZDEVOPS_API_ORGANIZATION_RESOURCE,
  AZDEVOPS_CLOUD_API_ORGANIZATION_OLD,
  getCommonServiceIdsValue,
  getZeroDataActionTypeValue,
  getStatusSizeValue,
  FILTER_STORE_KEY_NAME,
} from "../models/constants";

import { Spinner, SpinnerSize } from "office-ui-fabric-react";

// Custom
import * as Data from "./PulRequestsTabData";
import * as PullRequestModel from "../models/PullRequestModel";

// Azure DevOps SDK
import * as DevOps from "azure-devops-extension-sdk";

// Azure DevOps API
import { IProjectPageService, getClient, IHostNavigationService } from "azure-devops-extension-api";
import { GitRestClient } from "azure-devops-extension-api/Git/GitClient";
import {
  IdentityRefWithVote,
  PullRequestStatus,
} from "azure-devops-extension-api/Git/Git";

// Azure DevOps UI
import { ListSelection } from "azure-devops-ui/List";
import { Observer } from "azure-devops-ui/Observer";
import { Dialog } from "azure-devops-ui/Dialog";
import { Filter, FILTER_CHANGE_EVENT } from "azure-devops-ui/Utilities/Filter";
import {
  DropdownMultiSelection,
} from "azure-devops-ui/Utilities/DropdownSelection";
import {
  ObservableArray,
  IReadonlyObservableValue,
} from "azure-devops-ui/Core/Observable";
import { Card } from "azure-devops-ui/Card";
import { Status, Statuses } from "azure-devops-ui/Status";
import {
  Table,
  ColumnSorting,
  SortOrder,
  sortItems,
  ITableColumn,
  TableColumnStyle,
} from "azure-devops-ui/Table";
import { ZeroData } from "azure-devops-ui/ZeroData";
import { IdentityRef } from "azure-devops-extension-api/WebApi/WebApi";
import { ObservableValue } from "azure-devops-ui/Core/Observable";
import {
  TeamProjectReference,
  WebApiTagDefinition,
  ProjectInfo,
} from "azure-devops-extension-api/Core/Core";
import { FilterBarHub } from "../components/FilterBarHub";
import { hasPullRequestFailure } from "../models/constants";
import { ContentSize } from "azure-devops-ui/Callout";
import { IHeaderCommandBarItem } from "azure-devops-ui/HeaderCommandBar";
import { ShowErrorMessage, UserPreferencesInstance } from "../common";
import {
  StatusColumn,
  TitleColumn,
  DetailsColumn,
  DateColumn,
  ReviewersColumn,
} from "../components/Columns";
import { IListBoxItem } from "azure-devops-ui/ListBox";
import { GitRepositoryModel } from '../models/PullRequestModel';

export interface IPullRequestTabProps {
  prType: PullRequestStatus;
  projects: TeamProjectReference[];
  onCountChange: (count: number) => void;
  showToastMessage: (message: string) => void;
}

export class PullRequestsTab extends React.Component<
  IPullRequestTabProps,
  Data.IPullRequestsTabState
> {
  private baseUrl: string = "";
  private prRowSelecion = new ListSelection({
    selectOnFocus: true,
    multiSelect: false,
  });
  private isDialogOpen = new ObservableValue<boolean>(false);
  private filter: Filter;
  private selectedProjects = new DropdownMultiSelection();
  private selectedAuthors = new DropdownMultiSelection();
  private selectedRepos = new DropdownMultiSelection();
  private selectedSourceBranches = new DropdownMultiSelection();
  private selectedTargetBranches = new DropdownMultiSelection();
  private selectedReviewers = new DropdownMultiSelection();
  private selectedMyApprovalStatuses = new DropdownMultiSelection();
  private selectedAlternateStatusPr = new DropdownMultiSelection();
  private selectedTags = new DropdownMultiSelection();
  private pullRequestItemProvider = new ObservableArray<
    | PullRequestModel.PullRequestModel
    | IReadonlyObservableValue<PullRequestModel.PullRequestModel | undefined>
  >();

  private readonly gitClient: GitRestClient;

  constructor(props: IPullRequestTabProps) {
    super(props);

    this.selectedProjectChanged = this.selectedProjectChanged.bind(this);

    this.gitClient = getClient(GitRestClient);

    this.state = {
      projects: props.projects,
      pullRequests: [],
      repositories: [],
      createdByList: [],
      sourceBranchList: [],
      targetBranchList: [],
      reviewerList: [],
      tagList: [],
      loading: true,
      errorMessage: "",
      pullRequestCount: 0,
      savedProjects: [],
    };

    this.filter = new Filter();
  }

  public async componentDidMount() {
    DevOps.init().then(async () => {
      this.initializeState();
      this.setupFilter();
      await this.initializePage();
    });
  }

  componentWillUnmount() {
    this.unloadFilter();
  }

  private unloadFilter() {
    this.filter.unsubscribe(() => {
      this.filterPullRequests();
    }, FILTER_CHANGE_EVENT);
  }

  private setupFilter() {
    this.filter.subscribe(() => {
      this.filterPullRequests();
    }, FILTER_CHANGE_EVENT);
  }

  private async initializeState() {
    this.setState({
      pullRequests: [],
    });
  }

  private getCurrentFilterNameKey(): string {
    const filterKey = `MY_${FILTER_STORE_KEY_NAME}`;
    return filterKey;
  }

  private async saveCurrentFilters() {
    try {
      const filterKey = this.getCurrentFilterNameKey();
      const currentFilter = this.filter.getState();
      const serializedFilter = JSON.stringify(currentFilter);
      localStorage.setItem(filterKey, serializedFilter);
      this.props.showToastMessage(`Current selected filters have been saved.`);

      const navigationService = await DevOps.getService<IHostNavigationService>(
        getCommonServiceIdsValue("HostNavigationService")
      );
      navigationService.setHash(`${filterKey}=${serializedFilter}`);
    } catch (error) {
      this.handleError(error);
    }
  }

  private async clearSavedFilter() {
    try {
      const filterKey = this.getCurrentFilterNameKey();
      this.props.showToastMessage(`Saved filters have been removed.`);
      localStorage.removeItem(FILTER_STORE_KEY_NAME);
      localStorage.removeItem(filterKey);

      const navigationService = await DevOps.getService<IHostNavigationService>(
        getCommonServiceIdsValue("HostNavigationService")
      );
      navigationService.setHash("");

    } catch (error) {
      this.handleError(error);
    }
  }

  private async loadSavedFilter(): Promise<void> {
    try {
      const saveFilterKeyName = this.getCurrentFilterNameKey();
      const hashPrefix = `#${saveFilterKeyName}=`;

      const navigationService = await DevOps.getService<IHostNavigationService>(
        getCommonServiceIdsValue("HostNavigationService")
      );
      const hash = await navigationService.getHash();

      let storedSavedFilter;
      if (hash.startsWith(hashPrefix)) {
        storedSavedFilter = decodeURIComponent(hash.substr(hashPrefix.length));
      } else {
        storedSavedFilter = localStorage.getItem(saveFilterKeyName);
      }

      if (storedSavedFilter && storedSavedFilter.length > 0) {
        const savedFilterState = JSON.parse(storedSavedFilter);
        this.filter.setState(savedFilterState);
      }
    } catch (error) {
      this.handleError(error);
    }
  }

  private async initializePage() {
    let { savedProjects } = this.state;
    this.setState({
      repositories: [],
      sourceBranchList: [],
      targetBranchList: [],
      pullRequests: [],
    });

    this.getOrganizationBaseUrl()
      .then(async () => {
        await this.loadSavedFilter();

        this.setState({
          savedProjects,
        });

        await this.loadAllProjects();
      })
      .catch((error) => {
        this.handleError(error);
      });
  }

  private async loadAllProjects(): Promise<void> {
    let { savedProjects } = this.state;
    this.setState({
      repositories: [],
      sourceBranchList: [],
      targetBranchList: [],
      pullRequests: [],
    });

    const currentProjectId = localStorage.getItem(FILTER_STORE_KEY_NAME);
    const savedProjectsFilter = this.filter.getFilterItemValue<string[]>(
      "selectedProjects"
    );

    if (
      savedProjectsFilter !== undefined &&
      savedProjectsFilter.length > 0
    ) {
      savedProjects = savedProjectsFilter;
    }

    if (savedProjects.length === 0) {
      const projectService = await DevOps.getService<IProjectPageService>(
        getCommonServiceIdsValue("ProjectPageService")
      );

      const currentProject =
        currentProjectId && currentProjectId.length > 0
          ? currentProjectId
          : (await projectService.getProject())!.id;

      savedProjects.push(...[currentProject.toString()]);
    }

    this.filter.setFilterItemState("selectedProjects", { value: savedProjects });
    savedProjects.forEach(async (p) => {
      this.loadProject(p);
    });
  }

  private async loadProject(projectId: string): Promise<void> {
    const self = this;
    return self
      .getRepositories(projectId)
      .then((repos) => {
        this.getAllPullRequests(repos).catch((error) =>
          this.handleError(error)
        );
      })
      .catch((error) => {
        this.handleError(error);
      });
  }

  private handleError(error: any): void {
    console.log(error);
    this.setState({
      loading: false,
      errorMessage: "There was an error during the extension load: " + error,
    });
  }

  private async getRepositories(projectId: string): Promise<GitRepositoryModel[]> {
    const repos = (await this.gitClient.getRepositories(projectId, true) as GitRepositoryModel[]).filter(r => r.isDisabled === undefined || r.isDisabled === false);

    let currentRepos = this.state.repositories;
    currentRepos.push(...repos);
    currentRepos = currentRepos.sort(Data.sortTagRepoTeamProject);

    this.setState({
      repositories: currentRepos,
    });

    return repos;
  }

  private async getOrganizationBaseUrl() {

    if (this.baseUrl && this.baseUrl.length > 0) {
      return;
    }

    const oldOrgUrlFormat = AZDEVOPS_CLOUD_API_ORGANIZATION_OLD.replace(
      "[org]",
      DevOps.getHost().name
    );
    const url = new URL(document.referrer);

    console.log("Base URL reference: " + url.toString());

    if (
      url.origin !== AZDEVOPS_CLOUD_API_ORGANIZATION &&
      url.origin !== oldOrgUrlFormat
    ) {
      if (url.pathname.split("/")[1] === "tfs") {
        const collectionName = url.pathname.split("/")[2];
        this.baseUrl = `${url.origin}/tfs/${collectionName}/`;
      } else {
        const collectionName = url.pathname.split("/")[1];
        this.baseUrl = `${url.origin}/${collectionName}/`;
      }
    } else {
      const baseUrlFormat = `${AZDEVOPS_CLOUD_API_ORGANIZATION}/${AZDEVOPS_API_ORGANIZATION_RESOURCE}/?accountName=${
        DevOps.getHost().name
      }&api-version=5.0-preview.1`;

      await fetch(baseUrlFormat)
        .then((res) => res.json())
        .then((result) => {
          this.baseUrl = result.locationUrl;
        })
        .catch((error) => {
          this.handleError(
            "Unable to fetch Organization's URL. Details: " + error
          );
        });
    }

    console.log("Set base URL: " + this.baseUrl);
  }

  private reloadPullRequestItemProvider(
    newList: PullRequestModel.PullRequestModel[]
  ) {
    this.pullRequestItemProvider.splice(
      0,
      this.pullRequestItemProvider.length,
      ...newList
    );
    this.setState({
      pullRequestCount: newList.length,
    });

    this.props.onCountChange(newList.length);
  }

  private async getAllPullRequests(repositories: GitRepositoryModel[]) {
    const self = this;
    this.setState({ loading: true });
    let { pullRequests } = this.state;

    let newPullRequestList = Object.assign([], pullRequests);

    // clear the pull request list to be reloaded...
    newPullRequestList.splice(0, newPullRequestList.length);

    this.pullRequestItemProvider = new ObservableArray<
      | PullRequestModel.PullRequestModel
      | IReadonlyObservableValue<PullRequestModel.PullRequestModel | undefined>
    >([]);

    Promise.all(
      repositories.map(async (r) => {
        let criteria = Object.assign({}, Data.pullRequestCriteria);
        criteria.status = this.props.prType;
        const top =
          this.props.prType === PullRequestStatus.Completed ||
          this.props.prType === PullRequestStatus.Abandoned
            ? UserPreferencesInstance.topNumberCompletedAbandoned
            : 0;

        const loadedPullRequests = await this.gitClient.getPullRequests(
          r.id,
          criteria,
          undefined,
          10,
          undefined,
          top
        );

        return loadedPullRequests;
      })
    )
      .then((loadedPullRequests) => {
        loadedPullRequests.forEach((pr) => {
          if (!pr || pr.length === 0) {
            return pr;
          }

          newPullRequestList.push(
            ...PullRequestModel.PullRequestModel.getModels(
              pr,
              this.baseUrl,
              (updatedPr) => {
                let { tagList } = self.state;
                updatedPr.labels
                  .filter((t) => !this.hasFilterValue(tagList, t.id))
                  .forEach((t) => {
                    tagList.push(t);
                    tagList = tagList.sort(Data.sortTagRepoTeamProject);

                    return tagList;
                  });

                this.setState({
                  tagList,
                });

                this.filterPullRequests();
              }
            )
          );
          return pr;
        });
      })
      .catch((error) => {
        this.handleError(error);
      })
      .finally(async () => {
        if (newPullRequestList.length > 0) {
          pullRequests.push(...newPullRequestList);
          pullRequests = pullRequests.sort(Data.sortPullRequests);

          this.setState({
            pullRequests,
          });
        }

        await this.loadLists();
      });
  }

  private async loadLists() {
    const { pullRequests } = this.state;

    this.setState({
      loading: false
    });

    this.reloadPullRequestItemProvider([]);
    this.pullRequestItemProvider.push(...pullRequests);
    this.populateFilterBarFields(pullRequests);

    await this.loadSavedFilter();

    this.filterPullRequests();
  }

  private filterPullRequests() {
    const { pullRequests } = this.state;

    const selectedProjectsFilter = this.filter.getFilterItemValue<string[]>(
      "selectedProjects"
    );

    const repositoriesFilter = this.filter.getFilterItemValue<string[]>(
      "selectedRepos"
    );
    const filterPullRequestTitle = this.filter.getFilterItemValue<string>(
      "pullRequestTitle"
    );
    const sourceBranchFilter = this.filter.getFilterItemValue<string[]>(
      "selectedSourceBranches"
    );
    const targetBranchFilter = this.filter.getFilterItemValue<string[]>(
      "selectedTargetBranches"
    );
    const createdByFilter = this.filter.getFilterItemValue<string[]>(
      "selectedAuthors"
    );
    const reviewersFilter = this.filter.getFilterItemValue<string[]>(
      "selectedReviewers"
    );
    const myApprovalStatusFilter = this.filter.getFilterItemValue<string[]>(
      "selectedMyApprovalStatuses"
    );
    const selectedAlternateStatusPrFilter = this.filter.getFilterItemValue<
      string[]
    >("selectedAlternateStatusPr");
    const selectedTagsFilter = this.filter.getFilterItemValue<string[]>(
      "selectedTags"
    );

    let filteredPullRequest = pullRequests;

    if (selectedProjectsFilter && selectedProjectsFilter.length > 0) {
      filteredPullRequest = filteredPullRequest.filter((pr) => {
        const found = selectedProjectsFilter!.some((r) => {
          return pr.gitPullRequest.repository.project.id === r;
        });

        return found;
      });
    }

    if (filterPullRequestTitle && filterPullRequestTitle.length > 0) {
      filteredPullRequest = pullRequests.filter((pr) => {
        const found =
          pr
            .title!.toLocaleLowerCase()
            .indexOf(filterPullRequestTitle.toLocaleLowerCase()) > -1;
        return found;
      });
    }

    if (repositoriesFilter && repositoriesFilter.length > 0) {
      filteredPullRequest = filteredPullRequest.filter((pr) => {
        const found = repositoriesFilter!.some((r) => {
          return pr.gitPullRequest.repository.id === r;
        });

        return found;
      });
    }

    if (sourceBranchFilter && sourceBranchFilter.length > 0) {
      filteredPullRequest = filteredPullRequest.filter((pr) => {
        const found = sourceBranchFilter.some((r) => {
          return pr.sourceBranch!.displayName === r;
        });

        return found;
      });
    }

    if (targetBranchFilter && targetBranchFilter.length > 0) {
      filteredPullRequest = filteredPullRequest.filter((pr) => {
        const found = targetBranchFilter.some((r) => {
          return pr.targetBranch!.displayName === r;
        });

        return found;
      });
    }

    if (createdByFilter && createdByFilter.length > 0) {
      filteredPullRequest = filteredPullRequest.filter((pr) => {
        const found = createdByFilter.some((r) => {
          return pr.gitPullRequest.createdBy.id === r;
        });

        return found;
      });
    }

    if (reviewersFilter && reviewersFilter.length > 0) {
      filteredPullRequest = filteredPullRequest.filter((pr) => {
        const found = reviewersFilter.some((r) => {
          return pr.gitPullRequest.reviewers.some((rv) => {
            return rv.id === r;
          });
        });
        return found;
      });
    }

    if (myApprovalStatusFilter && myApprovalStatusFilter.length > 0) {
      filteredPullRequest = filteredPullRequest.filter((pr) => {
        const found = myApprovalStatusFilter.some((vote) => {
          return (
            pr.myApprovalStatus ===
            (parseInt(vote, 10) as Data.ReviewerVoteOption)
          );
        });
        return found;
      });
    }

    if (
      selectedAlternateStatusPrFilter &&
      selectedAlternateStatusPrFilter.length > 0
    ) {
      filteredPullRequest = filteredPullRequest.filter((pr) => {
        const found = selectedAlternateStatusPrFilter.some((item) => {
          return (
            (pr.gitPullRequest.isDraft === true &&
              item === Data.AlternateStatusPr.IsDraft) ||
            (hasPullRequestFailure(pr) === true &&
              item === Data.AlternateStatusPr.Conflicts) ||
            (pr.isAutoCompleteSet === true &&
              item === Data.AlternateStatusPr.AutoComplete) ||
            (pr.gitPullRequest.isDraft === false &&
              item === Data.AlternateStatusPr.NotIsDraft) ||
            (hasPullRequestFailure(pr) === false &&
              item === Data.AlternateStatusPr.NotConflicts) ||
            (pr.isAutoCompleteSet === false &&
              item === Data.AlternateStatusPr.NotAutoComplete) ||
            (pr.isAllPoliciesOk === true &&
              item === Data.AlternateStatusPr.ReadForCompletion &&
              pr.hasFailures === false) ||
            (item === Data.AlternateStatusPr.NotReadyForCompletion &&
              (pr.hasFailures === true || pr.isAllPoliciesOk === false)) ||
            (item === Data.AlternateStatusPr.HasNewChanges &&
              pr.hasNewChanges())
          );
        });
        return found;
      });
    }

    if (selectedTagsFilter && selectedTagsFilter.length > 0) {
      filteredPullRequest = filteredPullRequest.filter((pr) => {
        const found = selectedTagsFilter.some((item) => {
          return this.hasFilterValue(pr.labels, item);
        });
        return found;
      });
    }

    this.reloadPullRequestItemProvider(filteredPullRequest);
  }

  private hasFilterValue(
    list: Array<
      | Data.BranchDropDownItem
      | IdentityRef
      | IdentityRefWithVote
      | WebApiTagDefinition
    >,
    value: any
  ): boolean {
    return list.some((item) => {
      if (item.hasOwnProperty("id")) {
        const convertedValue = item as IdentityRef | WebApiTagDefinition;
        return convertedValue.id.localeCompare(value) === 0;
      } else if (item.hasOwnProperty("branchName")) {
        const convertedValue = item as Data.BranchDropDownItem;
        return convertedValue.displayName.localeCompare(value) === 0;
      } else {
        return item === value;
      }
    });
  }

  private populateFilterBarFields = (
    pullRequests: PullRequestModel.PullRequestModel[]
  ) => {
    let {
      sourceBranchList,
      targetBranchList,
      createdByList,
      reviewerList,
    } = this.state;

    sourceBranchList = [];
    targetBranchList = [];
    createdByList = [];
    reviewerList = [];

    pullRequests.forEach((pr) => {
      let found = this.hasFilterValue(
        createdByList,
        pr.gitPullRequest.createdBy.id
      );

      if (found === false) {
        createdByList.push(pr.gitPullRequest.createdBy);
      }

      found = this.hasFilterValue(
        sourceBranchList,
        pr.sourceBranch!.displayName
      );

      if (found === false) {
        sourceBranchList.push(pr.sourceBranch!);
      }

      found = this.hasFilterValue(
        targetBranchList,
        pr.targetBranch!.displayName
      );

      if (found === false) {
        targetBranchList.push(pr.targetBranch!);
      }

      if (
        pr.gitPullRequest.reviewers &&
        pr.gitPullRequest.reviewers.length > 0
      ) {
        pr.gitPullRequest.reviewers.map((r) => {
          found = this.hasFilterValue(reviewerList, r.id);

          if (found === false) {
            reviewerList.push(r);
          }

          return r;
        });
      }

      return pr;
    });

    sourceBranchList = sourceBranchList.sort(Data.sortBranchOrIdentity);
    targetBranchList = targetBranchList.sort(Data.sortBranchOrIdentity);
    createdByList = createdByList.sort(Data.sortBranchOrIdentity);
    reviewerList = reviewerList.sort(Data.sortBranchOrIdentity);

    this.setState({
      sourceBranchList,
      targetBranchList,
      createdByList,
      reviewerList,
    });
  };

  refresh = async () => {
    await this.loadAllProjects();
  };

  onHelpDismiss = () => {
    this.isDialogOpen.value = false;
  };

  public render(): JSX.Element {
    const {
      pullRequests,
      projects,
      repositories,
      createdByList,
      sourceBranchList,
      targetBranchList,
      reviewerList,
      loading,
      errorMessage,
      tagList,
    } = this.state;

    if (loading === true) {
      return (
        <div className="absolute-fill flex-column flex-grow flex-center justify-center">
          <Spinner size={SpinnerSize.large} label="loading..." />
        </div>
      );
    }

    return (
      <div className="flex-column">
        <FilterBarHub
          filterPullRequests={() => {
            this.initializePage();
            this.props.showToastMessage(`Filters have been restored to its original state.`);
          }}
          pullRequests={pullRequests}
          filter={this.filter}
          selectedProjectChanged={this.selectedProjectChanged}
          selectedProject={this.selectedProjects}
          projects={projects}
          repositories={repositories}
          selectedRepos={this.selectedRepos}
          sourceBranchList={sourceBranchList}
          selectedSourceBranches={this.selectedSourceBranches}
          targetBranchList={targetBranchList}
          selectedTargetBranches={this.selectedTargetBranches}
          createdByList={createdByList}
          selectedAuthors={this.selectedAuthors}
          reviewerList={reviewerList}
          selectedReviewers={this.selectedReviewers}
          selectedMyApprovalStatuses={this.selectedMyApprovalStatuses}
          selectedAlternateStatusPr={this.selectedAlternateStatusPr}
          tagList={tagList}
          selectedTags={this.selectedTags}
        />

        {errorMessage.length > 0 ? (
          <ShowErrorMessage
            errorMessage={errorMessage}
            onDismiss={this.resetErrorMessage}
          />
        ) : null}

        <div className="margin-top-8">
          <br />
          {this.getRenderContent()}
        </div>
      </div>
    );
  }

  resetErrorMessage() {
    this.setState({
      errorMessage: "",
    });
  }

  async selectedProjectChanged(
    _event: React.SyntheticEvent<HTMLElement, Event>,
    item: IListBoxItem<TeamProjectReference | ProjectInfo>
  ) {
    let { savedProjects } = this.state;
    const foundIndex = savedProjects.findIndex((p) => p === item.id);

    if (foundIndex < 0) {
      savedProjects.push(item.id);

      this.setState({
        savedProjects,
      });

      await this.loadProject(item.id);
    }
  }

  getRenderContent() {
    const { pullRequestCount, pullRequests } = this.state;

    // Create the sorting behavior (delegate that is called when a column is sorted).
    const sortingBehavior = new ColumnSorting<
      PullRequestModel.PullRequestModel
    >((columnIndex: number, proposedSortOrder: SortOrder) => {
      this.pullRequestItemProvider.splice(
        0,
        this.pullRequestItemProvider.length,
        ...sortItems<PullRequestModel.PullRequestModel>(
          columnIndex,
          proposedSortOrder,
          this.sortFunctions,
          this.columns,
          pullRequests
        )
      );
    });

    if (
      pullRequestCount === 0 &&
      pullRequests.filter((pr) => pr.isStillLoading() === true).length === 0
    ) {
      return (
        <ZeroData
          primaryText="Yeah! No Pull Request to be reviewed. Well done!"
          secondaryText={
            <span>
              Enjoy your free time to code and raise PRs for your team/project!
            </span>
          }
          imageAltText="No PRs!"
          imagePath={require("../images/emptyPRList.png")}
          actionText="Refresh"
          actionType={getZeroDataActionTypeValue("ctaButton")}
          onActionClick={this.refresh}
        />
      );
    } else {
      return (
        <Card
          key={this.props.prType}
          className="flex-grow bolt-table-card"
          contentProps={{ contentPadding: false }}
          headerCommandBarItems={this.listHeaderColumns}
        >
          <React.Fragment>
            <Table<PullRequestModel.PullRequestModel>
              key={this.props.prType}
              behaviors={[sortingBehavior]}
              columns={this.columns}
              itemProvider={this.pullRequestItemProvider}
              showLines={true}
              selection={this.prRowSelecion}
              singleClickActivation={true}
              role="table"
            />
          </React.Fragment>

          <Observer isDialogOpen={this.isDialogOpen}>
            {(props: { isDialogOpen: boolean }) => {
              return props.isDialogOpen ? (
                <Dialog
                  titleProps={{ text: "Help!" }}
                  contentSize={ContentSize.Auto}
                  footerButtonProps={[
                    {
                      text: "Close",
                      onClick: this.onHelpDismiss,
                    },
                  ]}
                  onDismiss={this.onHelpDismiss}
                >
                  <strong>Statuses legend:</strong>
                  <div className="flex-column" style={{ minWidth: "120px" }}>
                    <div className="flex-row body-m secondary-text margin-top-8">
                      <div className="flex-column" style={{ width: "40px" }}>
                        <Status
                          {...Statuses.Waiting}
                          key="waiting"
                          size={getStatusSizeValue("m")}
                          className="status-example flex-self-center "
                        />
                      </div>
                      <div className="flex-column">
                        &nbsp;No one has voted yet.
                      </div>
                    </div>
                    <div className="flex-row body-m secondary-text margin-top-8">
                      <div className="flex-column" style={{ width: "40px" }}>
                        <Status
                          {...Statuses.Running}
                          key="running"
                          size={getStatusSizeValue("m")}
                          className="status-example flex-self-center "
                        />
                      </div>
                      <div className="flex-column">
                        &nbsp;Review in progress, not all required reviwers have
                        approved or policies are passed.
                      </div>
                    </div>
                    <div className="flex-row body-m secondary-text margin-top-8">
                      <div className="flex-column" style={{ width: "40px" }}>
                        <Status
                          {...Statuses.Success}
                          key="success"
                          size={getStatusSizeValue("m")}
                          className="status-example flex-self-center "
                        />
                      </div>
                      <div className="flex-column">
                        &nbsp;Ready for completion.
                      </div>
                    </div>
                    <div className="flex-row body-m secondary-text margin-top-8">
                      <div className="flex-column" style={{ width: "40px" }}>
                        <Status
                          {...Statuses.Warning}
                          key="warning"
                          size={getStatusSizeValue("m")}
                          className="status-example flex-self-center "
                        />
                      </div>
                      <div className="flex-column">
                        &nbsp;At least one reviewer is Waiting For Author.
                      </div>
                    </div>
                    <div className="flex-row body-m secondary-text margin-top-8">
                      <div className="flex-column" style={{ width: "40px" }}>
                        <Status
                          {...Statuses.Failed}
                          key="failed"
                          size={getStatusSizeValue("m")}
                          className="status-example flex-self-center "
                        />
                      </div>
                      <div className="flex-column">
                        &nbsp;One or more members has rejected or there is a
                        failure in some policy or status.
                      </div>
                    </div>
                  </div>
                </Dialog>
              ) : null;
            }}
          </Observer>
        </Card>
      );
    }
  }

  sortFunctions = [
    null, //Status column
    null, // Title column
    null, // Details column
    // Sort on When column
    (
      item1: PullRequestModel.PullRequestModel,
      item2: PullRequestModel.PullRequestModel
    ): number => {
      return (
        item2.gitPullRequest.creationDate.getTime() -
        item1.gitPullRequest.creationDate.getTime()
      );
    },
    null, // Reviewers column
  ];

  columns: ITableColumn<PullRequestModel.PullRequestModel>[] = [
    {
      id: "status",
      name: "",
      renderCell: StatusColumn,
      readonly: true,
      width: -4,
      minWidth: -4,
      columnStyle: TableColumnStyle.Primary,
    },
    {
      id: "title",
      name: "Pull Request",
      renderCell: TitleColumn,
      readonly: true,
      width: -46,
    },
    {
      className: "pipelines-two-line-cell",
      id: "details",
      name: "Details",
      renderCell: DetailsColumn,
      width: -20,
    },
    {
      id: "time",
      name: "When",
      readonly: true,
      renderCell: DateColumn,
      width: -10,
      sortProps: {
        ariaLabelAscending: "Sorted new to older",
        ariaLabelDescending: "Sorted older to new",
        sortOrder:
          UserPreferencesInstance.selectedDefaultSorting === "asc"
            ? SortOrder.ascending
            : SortOrder.descending,
      },
    },
    {
      id: "reviewers",
      name: "Reviewers",
      renderCell: ReviewersColumn,
      width: -20,
    },
  ];

  private listHeaderColumns: IHeaderCommandBarItem[] = [
    {
      id: "refresh",
      text: "",
      isPrimary: true,
      tooltipProps: { text: "Refresh the list" },
      onActivate: () => {
        this.refresh();
      },
      iconProps: {
        iconName: "fabric-icon ms-Icon--Refresh",
      },
    },
    {
      id: "saveCurrentFilter",
      text: "",
      className: "save-filter-button",
      isPrimary: true,
      tooltipProps: { text: "Save Current Filters" },
      onActivate: () => {
        this.saveCurrentFilters();
      },
      iconProps: {
        iconName: "fabric-icon ms-Icon--Save",
      },
    },
    {
      id: "clearSavedFilters",
      text: "",
      className: "clear-filter-button",
      isPrimary: true,
      tooltipProps: { text: "Clear Saved Filters" },
      onActivate: () => {
        this.clearSavedFilter();
      },
      iconProps: {
        iconName: "fabric-icon ms-Icon--Clear",
      },
    },
    {
      id: "help",
      text: "Help",
      isPrimary: false,
      tooltipProps: { text: "Help" },
      onActivate: () => {
        this.isDialogOpen.value = true;
      },
      iconProps: {
        iconName: "fabric-icon ms-Icon--Help",
      },
    },
  ];
}
